import type { Logger } from '../vendor/proton-drive-sdk-account';

import { EventWatcher } from './drive/events';
import { Backoff } from './drive/backoff';
import { DriveTree } from './drive/tree';
import { acquireStateLock } from './session/lock';
import type { FileCredentials } from './session/credentials';
import { connect } from './proton/connect';
import { createWebDavHandler } from './webdav/handler';
import { FailedPutGuard, FAILED_PUT_GUARD_MS } from './webdav/guard';
import { parsePath } from './webdav/paths';
import { startServer, type RunningServer } from './webdav/server';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7395;

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
    /** Called once the server listens, with the URL it answers on. */
    onListening?: (url: URL) => void;
};

/**
 * Serves Proton Drive over WebDAV until the signal comes. It takes the state
 * lock, loads the session and refuses to start without one: the serve has no
 * authentication of its own, so its only gate is the signed-in session.
 */
export async function serveCommand(options: ServeOptions): Promise<number> {
    const { stateDir, host, port, logger, signal } = options;
    const release = await acquireStateLock(stateDir);
    try {
        const connection = await connect({ stateDir, logger, fakeDriveDir: options.fakeDriveDir });
        try {
            await connection.auth.loadSession();
            if (!connection.auth.isLoggedIn()) {
                logger.error(NOT_SIGNED_IN);
                return 1;
            }
            if (connection.credentials.rejectedAt) {
                logger.error(REFUSED_SESSION(connection.credentials.rejectedAt));
                return 1;
            }
            if (!isLoopback(host)) {
                logger.warn(LOOPBACK_WARNING(host));
            }
            const sdk = await connection.createDriveClient();
            const tree = new DriveTree(sdk, logger, new Backoff(connection.clock?.now.bind(connection.clock)), {
                rootPath: options.root ? parsePath(options.root) : undefined,
            });
            const server = startServer({
                host,
                port,
                handler: createWebDavHandler({
                    tree,
                    logger,
                    authProblem: () => authProblem(connection.credentials),
                    guard: new FailedPutGuard(FAILED_PUT_GUARD_MS, connection.clock?.now.bind(connection.clock)),
                }),
            });
            const watcher = new EventWatcher(sdk, tree, logger, {
                authProblem: () => authProblem(connection.credentials),
                setTimeout: connection.clock?.setTimeout.bind(connection.clock),
                clearTimeout: connection.clock?.clearTimeout.bind(connection.clock),
            });
            await watcher.start();
            logger.info(`Serving Proton Drive ${options.root ? `folder /${options.root}` : 'My files'} at ${server.url.href}`);
            options.onListening?.(server.url);
            await waitUntil(signal);
            logger.info('Stopping');
            watcher.stop();
            await stop(server);
            return 0;
        } finally {
            await connection.stop();
        }
    } finally {
        await release();
    }
}

/** Closes the listener even when stopping is interrupted, so the port frees. */
async function stop(server: RunningServer): Promise<void> {
    try {
        await server.stop();
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
