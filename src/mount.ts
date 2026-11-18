import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import type { Logger } from '../vendor/proton-drive-sdk-account';

import type { LogLevel } from './logger.ts';

import { prepareMountpoint, type MountpointRefusal } from './mountpoint.ts';
import { serveCommand, type ServeOptions } from './serve.ts';

/** How long rclone gets to unmount after the stop signal before it is killed. */
const STOP_GRACE_MS = 30_000;

/**
 * The name of the rclone remote the mount defines. rclone names the cache folder of a remote
 * after it, and adds a hash of each setting a flag or the environment gives it. The URL changes
 * with the port, so the remote's config holds it; the credential changes each run and stays in
 * the environment (see mountCommand), so each run has its own folder, named by cacheFolder.
 */
const REMOTE = 'pdm';

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
    /** Where rclone keeps the cache. Default: rclone's own, $RCLONE_CACHE_DIR, else $XDG_CACHE_HOME/rclone. */
    cacheDir: string;
}

/** Defaults for a mount that more than one device changes: another device's changes show within 30 s. */
export const DEFAULT_CACHE: Omit<CacheSettings, 'cacheDir'> = { dirCacheTime: '30s', vfsCacheMaxSize: '6G' };

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
export function cacheSettings(flags: CacheFlags, env: Record<string, string | undefined> = process.env): CacheSettings | string {
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
    // rclone's own default, named so the mount knows where to look for the files it has not uploaded.
    const rcloneCache = env.RCLONE_CACHE_DIR || path.join(env.XDG_CACHE_HOME || path.join(env.HOME || homedir(), '.cache'), 'rclone');
    return { dirCacheTime, vfsCacheMaxSize, cacheDir: cacheDir === undefined ? rcloneCache : path.resolve(cacheDir) };
}

/**
 * The rclone config that defines the remote as the serve at `url`. It holds no credential.
 *
 * Vendor `rclone` gives the WebDAV backend a modification-time precision, so the VFS cache
 * fingerprint holds the size and the modification time. With vendor `other` the fingerprint is
 * the size only, and a same-size edit from another device stays stale in the cache (#63).
 * Not `owncloud`: it also sets modification times with PROPPATCH, which the serve does not have.
 */
export function rcloneConfig(url: URL): string {
    return [`[${REMOTE}]`, 'type = webdav', `url = ${url.href}`, 'vendor = rclone', ''].join('\n');
}

/**
 * The folder, under `vfs` and `vfsMeta` in the cache folder, that rclone keeps the remote's cache in
 * when its environment sets the credential: the remote's name and a hash of the setting, as
 * rclone's fs.NewFs makes it (the first 5 characters of the URL-safe base64 of an MD5).
 */
export function cacheFolder(credential: string): string {
    const hash = createHash('md5').update(`bearer_token='${credential}'`).digest('base64url').slice(0, 5);
    return `${REMOTE}{${hash}}`;
}

/** The files rclone keeps a record of under `folder`, by their path in the Drive. */
function cachedFiles(cacheDir: string, folder: string): string[] {
    try {
        return readdirSync(path.join(cacheDir, 'vfsMeta', folder), { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => path.relative(path.join(cacheDir, 'vfsMeta', folder), path.join(entry.parentPath, entry.name)));
    } catch {
        return [];
    }
}

/**
 * rclone's level for each of ours. rclone's INFO adds a cache line every minute, so info and warn
 * keep rclone at its default NOTICE.
 */
const RCLONE_LOG_LEVEL: Record<LogLevel, string> = { debug: 'DEBUG', info: 'NOTICE', warn: 'NOTICE', error: 'ERROR' };

/** The arguments that mount the remote onto `mountpoint`, with rclone logging at `logLevel`. */
export function rcloneArgs(mountpoint: string, cache: CacheSettings, logLevel: LogLevel): string[] {
    return [
        'mount',
        `${REMOTE}:`,
        mountpoint,
        ...RCLONE_SETTINGS.flat().filter((part): part is string => part !== undefined),
        '--dir-cache-time',
        cache.dirCacheTime,
        '--vfs-cache-max-size',
        cache.vfsCacheMaxSize,
        '--cache-dir',
        cache.cacheDir,
        '--log-level',
        RCLONE_LOG_LEVEL[logLevel],
    ];
}

/**
 * Whether rclone holds `file` in `folder` of `cacheDir` and has not yet uploaded it. rclone keeps a
 * JSON record of each cached file under vfsMeta, and marks one it has not uploaded Dirty.
 *
 * rclone rewrites the record each time a file closes by emptying it and writing it again, so a stop
 * or a crash at that moment leaves it empty or cut short, and rclone drops such a file when it next
 * starts. A file with a record cut short counts as not yet uploaded when all of its content is on
 * disk, as a written file's is. A file rclone fetched only in part has holes, and is left to rclone.
 */
function isPending(cacheDir: string, folder: string, file: string): boolean {
    try {
        return JSON.parse(readFileSync(path.join(cacheDir, 'vfsMeta', folder, file), 'utf8'))?.Dirty === true;
    } catch {
        try {
            const { size, blocks } = statSync(path.join(cacheDir, 'vfs', folder, file));
            return blocks * 512 >= size;
        } catch {
            return false;
        }
    }
}

/** Whether rclone could read the record of `file` in `folder` of `cacheDir`. */
function hasRecord(cacheDir: string, folder: string, file: string): boolean {
    try {
        JSON.parse(readFileSync(path.join(cacheDir, 'vfsMeta', folder, file), 'utf8'));
        return true;
    } catch {
        return false;
    }
}

/** Writes a record that tells rclone all of `file` is on disk and not yet uploaded. */
function rewriteRecord(cacheDir: string, folder: string, file: string): void {
    const { size, mtime } = statSync(path.join(cacheDir, 'vfs', folder, file));
    const record = {
        ModTime: mtime.toISOString(),
        ATime: new Date().toISOString(),
        Size: size,
        Rs: size > 0 ? [{ Pos: 0, Size: size }] : [],
        Fingerprint: '',
        Dirty: true,
    };
    writeFileSync(path.join(cacheDir, 'vfsMeta', folder, file), JSON.stringify(record));
}

/** The paths in the Drive of the files rclone holds in `folder` of `cacheDir` and has not yet uploaded. */
export function pendingWrites(cacheDir: string, folder: string): string[] {
    return cachedFiles(cacheDir, folder)
        .filter((file) => isPending(cacheDir, folder, file))
        .sort();
}

/**
 * How many files rclone holds in `folder` of `cacheDir` and has not yet uploaded, by the same test
 * as pendingWrites. It reads the cache without blocking, so a running serve does not wait on it.
 */
export async function countPendingWrites(cacheDir: string, folder: string): Promise<number> {
    const root = path.join(cacheDir, 'vfsMeta', folder);
    let entries;
    try {
        entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch {
        return 0;
    }
    const files = entries.filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
    const pending = await Promise.all(
        files.map(async (file) => {
            try {
                return JSON.parse(await readFile(path.join(root, file), 'utf8'))?.Dirty === true;
            } catch {
                try {
                    const { size, blocks } = await stat(path.join(cacheDir, 'vfs', folder, file));
                    return blocks * 512 >= size;
                } catch {
                    return false;
                }
            }
        }),
    );
    return pending.filter(Boolean).length;
}

/** The line that gives how many uploads are pending. */
export function pendingLine(count: number): string {
    return `${count} ${count === 1 ? 'upload' : 'uploads'} pending`;
}

/** How often a running mount logs how many uploads are pending. */
export const PENDING_EVERY_MS = 60_000;

/**
 * Every `everyMs`, logs at info how many uploads in `folder` of `cacheDir` are pending: always on the
 * first tick, on each tick while some are, and once when the last one is on the Drive. Returns the stop.
 */
function reportPending(cacheDir: string, folder: string, everyMs: number, logger: Logger): () => void {
    let last: number | undefined;
    let scanning = false;
    let stopped = false;
    const tick = async () => {
        if (scanning) return;
        scanning = true;
        try {
            const count = await countPendingWrites(cacheDir, folder);
            if (stopped) return;
            if (last === undefined || count > 0 || last > 0) logger.info(pendingLine(count));
            last = count;
        } finally {
            scanning = false;
        }
    };
    const timer = setInterval(() => void tick(), everyMs);
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

/** The folder, in the cache dir, where the mount notes which mount made each cache folder. */
const OWNERS = 'proton-drive-mount';

/**
 * Names the mount a cache folder belongs to: its state dir, which holds the account's session, and
 * its --root. A pending write goes only to a later mount with the same owner, so it reaches the
 * same account and the same folder of the Drive.
 */
export function cacheOwner(stateDir: string, root: string | undefined): string {
    return JSON.stringify([path.resolve(stateDir), (root ?? '').replace(/^\/+|\/+$/g, '')]);
}

/** A file an earlier mount left and did not upload, which stays where it is, and why. */
export interface KeptWrite {
    file: string;
    reason: string;
}

/** The owner noted for `folder` in `cacheDir`, if any. */
function ownerOf(cacheDir: string, folder: string): string | undefined {
    try {
        return readFileSync(path.join(cacheDir, OWNERS, folder), 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * Notes `owner` as the owner of `folder`, then moves each file that an earlier mount of the same
 * owner left in `cacheDir` and did not upload into `folder`, where rclone uploads it when it starts,
 * and removes the rest of those earlier mounts' cache. Earlier mounts are the folders `pdm{…}` that
 * cacheFolder names; a folder with another owner, or none, stays as it is. A file it cannot move
 * stays where it is, and so does the folder that holds it. Returns the paths in the Drive it moved,
 * and the files it kept.
 */
export function adoptPendingWrites(cacheDir: string, folder: string, owner: string): { moved: string[]; kept: KeptWrite[] } {
    const moved: string[] = [];
    const kept: KeptWrite[] = [];
    try {
        mkdirSync(path.join(cacheDir, OWNERS), { recursive: true });
        writeFileSync(path.join(cacheDir, OWNERS, folder), owner);
    } catch {
        // rclone says what is wrong with the cache dir when it starts.
        return { moved, kept };
    }
    let earlier: string[];
    try {
        earlier = readdirSync(path.join(cacheDir, 'vfsMeta')).filter(
            (name) => name !== folder && name.startsWith(`${REMOTE}{`) && name.endsWith('}') && ownerOf(cacheDir, name) === owner,
        );
    } catch {
        return { moved, kept };
    }
    for (const old of earlier) {
        let keep = false;
        for (const file of pendingWrites(cacheDir, old)) {
            try {
                for (const kind of ['vfs', 'vfsMeta']) {
                    const to = path.join(cacheDir, kind, folder, file);
                    mkdirSync(path.dirname(to), { recursive: true });
                    renameSync(path.join(cacheDir, kind, old, file), to);
                }
                if (!hasRecord(cacheDir, folder, file)) rewriteRecord(cacheDir, folder, file);
                moved.push(file);
            } catch (error) {
                keep = true;
                kept.push({ file: path.join(cacheDir, 'vfs', old, file), reason: error instanceof Error ? error.message : String(error) });
            }
        }
        if (keep) continue;
        try {
            // The rest is cache only: if it will not go, a later mount tries again.
            for (const kind of ['vfs', 'vfsMeta']) rmSync(path.join(cacheDir, kind, old), { recursive: true, force: true });
            rmSync(path.join(cacheDir, OWNERS, old), { force: true });
        } catch {}
    }
    return { moved: moved.sort(), kept };
}

/** A running rclone: when it ended, and a way to ask it to unmount and end. */
export interface RcloneProcess {
    exited: Promise<number>;
    stop(): void;
}

/**
 * The environment rclone runs with: `base` with `extra` added and the config read from file
 * descriptor 3. It leaves out the user's own RCLONE_WEBDAV_* and RCLONE_CONFIG_* settings, which
 * rclone would apply to the remote and which would change the folder its cache goes in.
 */
export function rcloneEnv(base: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(base)) {
        if (value === undefined || name.startsWith('RCLONE_WEBDAV_') || name.startsWith('RCLONE_CONFIG')) continue;
        env[name] = value;
    }
    return { ...env, ...extra, RCLONE_CONFIG: '/dev/fd/3' };
}

/** Writes each line of `stream` to stderr after "rclone: ", so a journal tells rclone's lines from ours. */
function markLines(stream: Readable): void {
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => process.stderr.write(`rclone: ${line}\n`));
}

/**
 * Starts rclone with `config` as its config and `env` added to this process's environment (see rcloneEnv). rclone
 * reads the config from file descriptor 3, an open file that has no name left on disk, so there is
 * nothing to remove when the mount ends. Its output goes to stderr, each line marked (see markLines).
 */
export function spawnRclone(executable: string, args: string[], config: string, env: Record<string, string> = {}): RcloneProcess {
    let dir: string;
    try {
        dir = mkdtempSync(path.join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'pdm-rclone-'));
    } catch {
        dir = mkdtempSync(path.join(tmpdir(), 'pdm-rclone-'));
    }
    const file = path.join(dir, 'rclone.conf');
    const fd = openSync(file, 'wx+', 0o600);
    unlinkSync(file);
    rmdirSync(dir);
    writeSync(fd, config);
    const child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe', fd],
        env: rcloneEnv(process.env, env),
    });
    closeSync(fd);
    markLines(child.stdout!);
    markLines(child.stderr!);
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

export type MountOptions = Omit<ServeOptions, 'onListening' | 'credential'> & { mountpoint: string; cache: CacheSettings; logLevel?: LogLevel };

export interface MountDeps {
    serve: (options: ServeOptions) => Promise<number>;
    startRclone: (executable: string, args: string[], config: string, env: Record<string, string>) => RcloneProcess;
    /** The rclone executable: the one the package pins. */
    rclone: string;
    /** Makes the mountpoint an empty folder rclone can mount on, or says why it will not. */
    prepareMountpoint: (path: string) => Promise<MountpointRefusal | undefined>;
    /** How often the running mount logs how many uploads are pending. PENDING_EVERY_MS when not given. */
    pendingEveryMs?: number;
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
 * unmounts) and then the serve. Either one ending on its own ends the other. rclone does not
 * wait for its uploads when it stops, so the mount then names each file not yet on the Drive;
 * the next mount with the same cache folder uploads them. While it runs, it logs how many uploads
 * are pending every minute (see reportPending).
 *
 * Each run makes a fresh credential that the serve demands on every request. rclone gets it
 * in its environment, which only this user can read, and never on its command line, which every
 * user can. rclone names its cache folder after the credential (see cacheFolder), so before rclone
 * starts the mount moves the files earlier mounts did not upload into this run's folder.
 */
export async function mountCommand(options: MountOptions, deps: MountDeps = mountDeps()): Promise<number> {
    const { mountpoint, cache, logLevel = 'info', ...serveOptions } = options;
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
    const folder = cacheFolder(credential);
    const { moved, kept } = adoptPendingWrites(cache.cacheDir, folder, cacheOwner(serveOptions.stateDir, serveOptions.root));
    for (const { file, reason } of kept) {
        logger.warn(`${file} was left by an earlier mount and is not on the Drive, but the mount could not take it over: ${reason}`);
    }
    for (const adopted of moved) {
        logger.info(`${adopted}, left by an earlier mount, uploads now.`);
    }
    const args = rcloneArgs(mountpoint, cache, logLevel);
    logger.debug(`Starting rclone ${args.join(' ')}`);
    const rclone = deps.startRclone(deps.rclone, args, rcloneConfig(first), { RCLONE_WEBDAV_BEARER_TOKEN: credential });
    logger.info(`Mounting ${first.href} at ${mountpoint}`);
    const stopReporting = reportPending(cache.cacheDir, folder, deps.pendingEveryMs ?? PENDING_EVERY_MS, logger);
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
    stopReporting();
    for (const pending of pendingWrites(cache.cacheDir, folder)) {
        logger.warn(`${pending} is not yet on the Drive. The next mount with this cache folder, state dir and root uploads it.`);
    }
    serveStop.abort();
    const serveCode = await served;
    if (outcome === 'signal') return 0;
    if ('rclone' in outcome) return outcome.rclone || serveCode || 1;
    return outcome.serve || rcloneCode;
}

export type { Logger };
