import type { Logger } from '../vendor/proton-drive-sdk-account';

import { EventWatcher } from './drive/events';
import { Backoff } from './drive/backoff';
import { ListingCacheFile } from './drive/listing-cache';
import { ListingSaver } from './drive/listing-saver';
import { DriveTree } from './drive/tree';
import { acquireStateLock } from './session/lock';
import type { FileCredentials } from './session/credentials';
import { connect } from './proton/connect';
import { guardAccess } from './webdav/access';
import { createWebDavHandler } from './webdav/handler';
import { FailedPutGuard, FAILED_PUT_GUARD_MS } from './webdav/guard';
import { parsePath } from './webdav/paths';
import { startServer, type RunningServer } from './webdav/server';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7395;

/** The exit status of a serve that needs `auth login` first: a user service stops on it instead of restarting. */
export const NEEDS_LOGIN = 3;

export const NOT_SIGNED_IN = 'Not signed in to Proton. Run "proton-drive-mount auth login" first.';
export const REFUSED_SESSION = (rejectedAt: string) =>
    `Proton refused the stored session at ${rejectedAt}. Run "proton-drive-mount auth login" again.`;
export const LOOPBACK_WARNING = (host: string) =>
    `Listening on ${host}: anyone who can reach it gets full access to your Drive. Prefer 127.0.0.1.`;

export type ServeOptions = {
    stateDir: string;
    host: string;
    port: number;
    logger: Logger;
    /** The fake drive's directory (`--fake-drive`): the Drive then comes from the Receive arm. */
    fakeDriveDir?: string;
    /** A folder of My files to serve as the root (`--root`), for example `Photos/immich`. */
    root?: string;
    /** Resolves when the serve should stop; SIGINT and SIGTERM resolve it. */
    signal?: AbortSignal;
    /**
     * A per-run secret every request must carry as `Authorization: Bearer`. The mount sets it
     * and hands it to rclone; a standalone serve has none and relies on the Host check alone.
     */
    credential?: string;
    /** Called once the server listens, with the URL it answers on. */
    onListening?: (url: URL) => void;
};

/**
 * Serves Proton Drive over WebDAV until the signal comes. It takes the state
 * lock, loads the session and refuses to start without one. Every request must name
 * loopback or the listen address in its Host header (so a web page cannot reach it by
 * DNS rebinding), and must carry `credential` when one is set.
 *
 * Without a usable session it exits with NEEDS_LOGIN, at the start or when Proton refuses
 * the session while it runs. Then the request that met the refusal still gets its 401.
 */
export async function serveCommand(options: ServeOptions): Promise<number> {
    const { stateDir, host, port, logger, signal } = options;
    const release = await acquireStateLock(stateDir);
    try {
        const connection = await connect({ stateDir, logger, fakeDriveDir: options.fakeDriveDir });
        try {
            await connection.auth.loadSession();
            const problem = authProblem(connection.credentials);
            if (problem) {
                logger.error(problem);
                return NEEDS_LOGIN;
            }
            const refused = new Promise<'refused'>((resolve) =>
                connection.credentials.on('sessionInfoChanged', () => {
                    if (authProblem(connection.credentials)) resolve('refused');
                }),
            );
            if (!isLoopback(host)) {
                logger.warn(LOOPBACK_WARNING(host));
            }
            const sdk = await connection.createDriveClient();
            const cacheFile = new ListingCacheFile(stateDir);
            const tree = new DriveTree(sdk, logger, new Backoff(connection.clock?.now.bind(connection.clock)), {
                rootPath: options.root ? parsePath(options.root) : undefined,
                restore: await cacheFile.read(),
            });
            const server = startServer({
                host,
                port,
                handler: guardAccess(
                    createWebDavHandler({
                        tree,
                        logger,
                        authProblem: () => authProblem(connection.credentials),
                        guard: new FailedPutGuard(FAILED_PUT_GUARD_MS, connection.clock?.now.bind(connection.clock)),
                    }),
                    { host, credential: options.credential, logger },
                ),
            });
            const watcher = new EventWatcher(sdk, tree, logger, {
                authProblem: () => authProblem(connection.credentials),
                setTimeout: connection.clock?.setTimeout.bind(connection.clock),
                clearTimeout: connection.clock?.clearTimeout.bind(connection.clock),
            });
            await watcher.start();
            const saver = new ListingSaver({
                state: () => (tree.snapshot() && watcher.lastEventId !== undefined ? `${tree.listingsLoaded}:${watcher.lastEventId}` : undefined),
                save: () => writeListings(cacheFile, tree, watcher),
                onError: (error) => logger.warn(couldNotSave(cacheFile, error)),
                setTimeout: connection.clock?.setTimeout.bind(connection.clock),
                clearTimeout: connection.clock?.clearTimeout.bind(connection.clock),
            });
            saver.start();
            logger.info(`Serving Proton Drive ${options.root ? `folder /${options.root}` : 'My files'} at ${server.url.href}`);
            options.onListening?.(server.url);
            const ended = await Promise.race([waitUntil(signal).then(() => 'signal' as const), refused]);
            if (ended === 'refused') {
                logger.error(authProblem(connection.credentials)!);
            }
            logger.info('Stopping');
            watcher.stop();
            await saver.stop();
            // On a refusal, let the request that met it finish with its 401.
            await stop(server, ended === 'refused');
            await saveListings(cacheFile, tree, watcher, logger);
            return ended === 'refused' ? NEEDS_LOGIN : 0;
        } finally {
            await connection.stop();
        }
    } finally {
        await release();
    }
}

/**
 * Saves the loaded listings with the last event they are true up to, so the
 * next start replays the events since then instead of listing again. With no
 * event read yet there is nothing to replay from, and nothing is saved.
 */
export async function saveListings(cacheFile: ListingCacheFile, tree: DriveTree, watcher: EventWatcher, logger: Logger): Promise<void> {
    try {
        await writeListings(cacheFile, tree, watcher);
    } catch (error) {
        logger.warn(couldNotSave(cacheFile, error));
    }
}

/** As `saveListings`, but throws when the file cannot be written. */
async function writeListings(cacheFile: ListingCacheFile, tree: DriveTree, watcher: EventWatcher): Promise<void> {
    const snapshot = tree.snapshot();
    const lastEventId = watcher.lastEventId;
    if (!snapshot || lastEventId === undefined) {
        return;
    }
    await cacheFile.write({ ...snapshot, lastEventId });
}

function couldNotSave(cacheFile: ListingCacheFile, error: unknown): string {
    return `Could not save the listings to ${cacheFile.filePath}: ${error instanceof Error ? error.message : String(error)}`;
}

/** Closes the listener even when stopping is interrupted, so the port frees. */
async function stop(server: RunningServer, graceful: boolean): Promise<void> {
    try {
        await server.stop(graceful);
    } catch {
        // The listener is gone either way; the exit code stays 0.
    }
}

function waitUntil(signal?: AbortSignal): Promise<void> {
    if (signal) {
        if (signal.aborted) {
            return Promise.resolve();
        }
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    return new Promise((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
    });
}

export function isLoopback(host: string): boolean {
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/**
 * Why Proton calls cannot work right now, or `undefined` when they can. Checked
 * before each request against the live credentials, so a session Proton refuses
 * mid-run starts answering 401 without another Drive call.
 */
export function authProblem(credentials: FileCredentials): string | undefined {
    if (credentials.isLoggedIn()) {
        return undefined;
    }
    if (credentials.rejectedAt) {
        return REFUSED_SESSION(credentials.rejectedAt);
    }
    return NOT_SIGNED_IN;
}
