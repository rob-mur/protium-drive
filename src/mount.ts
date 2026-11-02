import { spawn } from 'node:child_process';

import type { Logger } from '../vendor/proton-drive-sdk-account';

import { serveCommand, type ServeOptions } from './serve.ts';

/** How long rclone gets to unmount after the stop signal before it is killed. */
const STOP_GRACE_MS = 30_000;

/**
 * The rclone settings the prototype ran with and the suite tests, as [flag, value] pairs.
 * A flag with no value is a switch.
 */
export const RCLONE_SETTINGS: readonly (readonly [string, string?])[] = [
    ['--vfs-cache-mode', 'full'],
    ['--vfs-cache-max-size', '6G'],
    ['--vfs-write-back', '5s'],
    ['--dir-cache-time', '1000h'],
    ['--attr-timeout', '1000h'],
    ['--no-modtime'],
    ['--no-checksum'],
    ['--timeout', '1h'],
    ['--transfers', '2'],
];

/** The arguments that mount the serve at `url` onto `mountpoint` as a `:webdav:` remote. */
export function rcloneArgs(mountpoint: string, url: URL): string[] {
    return [
        'mount',
        ':webdav:',
        mountpoint,
        `--webdav-url=${url.href}`,
        '--webdav-vendor=other',
        ...RCLONE_SETTINGS.flat().filter((part): part is string => part !== undefined),
    ];
}

/** A running rclone: when it ended, and a way to ask it to unmount and end. */
export interface RcloneProcess {
    exited: Promise<number>;
    stop(): void;
}

export function spawnRclone(executable: string, args: string[]): RcloneProcess {
    const child = spawn(executable, args, { stdio: ['ignore', 'inherit', 'inherit'] });
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

export type MountOptions = Omit<ServeOptions, 'onListening'> & { mountpoint: string };

export interface MountDeps {
    serve: (options: ServeOptions) => Promise<number>;
    startRclone: (executable: string, args: string[]) => RcloneProcess;
    /** The rclone executable: the one the package pins. */
    rclone: string;
}

export function mountDeps(env: NodeJS.ProcessEnv = process.env): MountDeps {
    return { serve: serveCommand, startRclone: spawnRclone, rclone: env.PDM_RCLONE || 'rclone' };
}

/**
 * Runs the serve and an rclone mount of it until the signal comes, then stops rclone (which
 * unmounts) and then the serve. Either one ending on its own ends the other.
 */
export async function mountCommand(options: MountOptions, deps: MountDeps = mountDeps()): Promise<number> {
    const { mountpoint, signal, logger } = options;
    const serveStop = new AbortController();
    let listening!: (url: URL) => void;
    const listens = new Promise<URL>((resolve) => (listening = resolve));
    const served = deps.serve({ ...options, signal: serveStop.signal, onListening: listening });
    const first = await Promise.race([listens, served]);
    if (typeof first === 'number') {
        return first;
    }
    const rclone = deps.startRclone(deps.rclone, rcloneArgs(mountpoint, first));
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
