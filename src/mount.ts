import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import type { Logger } from '../vendor/proton-drive-sdk-account';

import { prepareMountpoint, type MountpointRefusal } from './mountpoint.ts';
import { serveCommand, type ServeOptions } from './serve.ts';

/** How long rclone gets to unmount after the stop signal before it is killed. */
const STOP_GRACE_MS = 30_000;

/**
 * The rclone settings the suite tests that a user cannot change, as [flag, value] pairs. A flag
 * with no value is a switch. The short attribute timeout lets another device's changes show; the
 * directory cache time, the cache size and the cache folder are in {@link CacheSettings}.
 */
export const RCLONE_SETTINGS: readonly (readonly [string, string?])[] = [
    ['--vfs-cache-mode', 'full'],
    ['--vfs-write-back', '5s'],
    ['--attr-timeout', '1s'],
    ['--no-modtime'],
    ['--no-checksum'],
    ['--timeout', '1h'],
    ['--transfers', '2'],
];

/** The cache settings a user can give `mount`. Each one passes to rclone's flag of the same name. */
export interface CacheSettings {
    /** How long rclone trusts a folder listing before it asks the serve again. */
    dirCacheTime: string;
    /** The most file content rclone keeps on disk, or `off` for no limit. */
    vfsCacheMaxSize: string;
    /** Where rclone keeps the cache. Default: rclone's own (~/.cache/rclone). */
    cacheDir?: string;
}

/** Defaults for a mount that more than one device changes: another device's changes show within 30 s. */
export const DEFAULT_CACHE: CacheSettings = { dirCacheTime: '30s', vfsCacheMaxSize: '6G' };

/** A duration as rclone reads one: 500ms, 30s, 1h30m, 1.5h, 2d. */
const DURATION = /^(\d+(\.\d+)?(ms|s|m|h|d|w|M|y))+$/;
/** A size as rclone reads one: bytes, or a number with a K/M/G/T/P suffix, or `off`. */
const SIZE = /^(off|\d+(\.\d+)?([bBkKmMgGtTpP]i?[bB]?)?)$/;

/** The cache flags as `mount` takes them, before checks. */
export interface CacheFlags {
    'dir-cache-time'?: string;
    'vfs-cache-max-size'?: string;
    'cache-dir'?: string;
}

/**
 * The cache settings from the flags the user gave, with the defaults for the rest, or a message
 * that names the first flag whose value rclone would refuse. It checks before the serve starts,
 * so a bad value never leaves a serve running without a mount.
 */
export function cacheSettings(flags: CacheFlags): CacheSettings | string {
    const dirCacheTime = flags['dir-cache-time'] ?? DEFAULT_CACHE.dirCacheTime;
    if (!DURATION.test(dirCacheTime)) {
        return `Bad --dir-cache-time ${JSON.stringify(dirCacheTime)}: give a duration such as 30s, 5m or 1h30m.`;
    }
    const vfsCacheMaxSize = flags['vfs-cache-max-size'] ?? DEFAULT_CACHE.vfsCacheMaxSize;
    if (!SIZE.test(vfsCacheMaxSize)) {
        return `Bad --vfs-cache-max-size ${JSON.stringify(vfsCacheMaxSize)}: give a size such as 512M or 6G, or off.`;
    }
    const cacheDir = flags['cache-dir'];
    if (cacheDir === '') {
        return 'Bad --cache-dir "": give a folder.';
    }
    return cacheDir === undefined ? { dirCacheTime, vfsCacheMaxSize } : { dirCacheTime, vfsCacheMaxSize, cacheDir };
}

/**
 * The arguments that mount the serve at `url` onto `mountpoint` as a `:webdav:` remote.
 *
 * Vendor `rclone` gives the WebDAV backend a modification-time precision, so the VFS cache
 * fingerprint holds the size and the modification time. With vendor `other` the fingerprint is
 * the size only, and a same-size edit from another device stays stale in the cache (#63).
 * Not `owncloud`: it also sets modification times with PROPPATCH, which the serve does not have.
 */
export function rcloneArgs(mountpoint: string, url: URL, cache: CacheSettings): string[] {
    return [
        'mount',
        ':webdav:',
        mountpoint,
        `--webdav-url=${url.href}`,
        '--webdav-vendor=rclone',
        ...RCLONE_SETTINGS.flat().filter((part): part is string => part !== undefined),
        '--dir-cache-time',
        cache.dirCacheTime,
        '--vfs-cache-max-size',
        cache.vfsCacheMaxSize,
        ...(cache.cacheDir === undefined ? [] : ['--cache-dir', cache.cacheDir]),
    ];
}

/** A running rclone: when it ended, and a way to ask it to unmount and end. */
export interface RcloneProcess {
    exited: Promise<number>;
    stop(): void;
}

/** Starts rclone with `env` added to this process's environment. */
export function spawnRclone(executable: string, args: string[], env: Record<string, string> = {}): RcloneProcess {
    const child = spawn(executable, args, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } });
    const exited = new Promise<number>((resolve) => {
        child.once('error', () => resolve(127));
        child.once('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
    return {
        exited,
        stop: () => {
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS).unref();
        },
    };
}

export type MountOptions = Omit<ServeOptions, 'onListening' | 'credential'> & { mountpoint: string; cache?: CacheSettings };

export interface MountDeps {
    serve: (options: ServeOptions) => Promise<number>;
    startRclone: (executable: string, args: string[], env: Record<string, string>) => RcloneProcess;
    /** The rclone executable: the one the package pins. */
    rclone: string;
    /** Makes the mountpoint an empty folder rclone can mount on, or says why it will not. */
    prepareMountpoint: (path: string) => Promise<MountpointRefusal | undefined>;
}

export function mountDeps(env: NodeJS.ProcessEnv = process.env): MountDeps {
    return {
        serve: serveCommand,
        startRclone: spawnRclone,
        rclone: env.PDM_RCLONE || 'rclone',
        prepareMountpoint,
    };
}

/**
 * Makes the mountpoint ready (see prepareMountpoint) before anything starts, then
 * runs the serve and an rclone mount of it until the signal comes, then stops rclone (which
 * unmounts) and then the serve. Either one ending on its own ends the other.
 *
 * Each run makes a fresh credential that the serve demands on every request. rclone gets it
 * in its environment, which only this user can read, and never on its command line, which
 * every user can.
 */
export async function mountCommand(options: MountOptions, deps: MountDeps = mountDeps()): Promise<number> {
    const { mountpoint, cache = DEFAULT_CACHE, ...serveOptions } = options;
    const { signal, logger } = serveOptions;
    const refusal = await deps.prepareMountpoint(mountpoint);
    if (refusal) {
        logger.error(refusal.message);
        return refusal.code;
    }
    const serveStop = new AbortController();
    let listening!: (url: URL) => void;
    const listens = new Promise<URL>((resolve) => (listening = resolve));
    const credential = randomBytes(32).toString('base64url');
    const served = deps.serve({ ...serveOptions, credential, signal: serveStop.signal, onListening: listening });
    const first = await Promise.race([listens, served]);
    if (typeof first === 'number') {
        return first;
    }
    const rclone = deps.startRclone(deps.rclone, rcloneArgs(mountpoint, first, cache), { RCLONE_WEBDAV_BEARER_TOKEN: credential });
    logger.info(`Mounting ${first.href} at ${mountpoint}`);
    const aborted = new Promise<'signal'>((resolve) => {
        if (signal?.aborted) resolve('signal');
        signal?.addEventListener('abort', () => resolve('signal'), { once: true });
    });
    const outcome = await Promise.race([
        aborted,
        rclone.exited.then((code) => ({ rclone: code })),
        served.then((code) => ({ serve: code })),
    ]);
    if (typeof outcome === 'object' && 'rclone' in outcome) {
        logger.error(`rclone ended with code ${outcome.rclone}`);
    } else {
        rclone.stop();
    }
    const rcloneCode = await rclone.exited;
    serveStop.abort();
    const serveCode = await served;
    if (outcome === 'signal') return 0;
    if ('rclone' in outcome) return outcome.rclone || serveCode || 1;
    return outcome.serve || rcloneCode;
}

export type { Logger };
