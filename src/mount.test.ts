import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createLogger } from './logger.ts';
import {
    adoptPendingWrites,
    cacheFolder,
    cacheOwner,
    cacheSettings,
    DEFAULT_CACHE,
    mountCommand,
    pendingWrites,
    rcloneArgs,
    rcloneConfig,
    rcloneEnv,
    spawnRclone,
    RCLONE_SETTINGS,
    type CacheSettings,
    type Logger,
    type RcloneProcess,
} from './mount.ts';
import type { ServeOptions } from './serve.ts';

const QUIET = createLogger({ PDM_LOG_LEVEL: 'error' });

const CACHE: CacheSettings = { ...DEFAULT_CACHE, cacheDir: '/c' };

describe('rcloneArgs', () => {
    test('mounts the pdm: remote with the tested settings, and names neither the URL nor a credential', () => {
        const args = rcloneArgs('/mnt/drive', CACHE);
        expect(args.slice(0, 3)).toEqual(['mount', 'pdm:', '/mnt/drive']);
        expect(args.join(' ')).not.toContain('webdav');
        for (const [flag, value] of RCLONE_SETTINGS) {
            const at = args.indexOf(flag);
            expect(at).toBeGreaterThan(-1);
            if (value !== undefined) expect(args[at + 1]).toBe(value);
        }
    });

    test('without cache settings, carries the documented defaults for a multi-device mount', () => {
        const args = rcloneArgs('/m', CACHE).join(' ');
        for (const setting of [
            '--vfs-cache-mode full',
            '--vfs-cache-max-size 6G',
            '--vfs-write-back 5s',
            '--dir-cache-time 30s',
            '--attr-timeout 1s',
            '--no-modtime',
            '--no-checksum',
            '--timeout 1h',
            '--transfers 2',
        ]) {
            expect(args).toContain(setting);
        }
        expect(args).toContain('--cache-dir /c');
    });

    test('passes the cache settings the user gave', () => {
        const args = rcloneArgs('/m', {
            dirCacheTime: '5s',
            vfsCacheMaxSize: '1G',
            cacheDir: '/var/cache/pdm',
        }).join(' ');
        expect(args).toContain('--dir-cache-time 5s');
        expect(args).toContain('--vfs-cache-max-size 1G');
        expect(args).toContain('--cache-dir /var/cache/pdm');
        expect(args).not.toContain('--dir-cache-time 30s');
        expect(args).not.toContain('--vfs-cache-max-size 6G');
    });
});

describe('spawnRclone', () => {
    test('gives the child the config on file descriptor 3 from a file with no name left, and the env from rcloneEnv, also with no runtime dir', async () => {
        const out = mkdtempSync(join(tmpdir(), 'pdm-spawn-'));
        const saved = { runtime: process.env.XDG_RUNTIME_DIR, url: process.env.RCLONE_WEBDAV_URL };
        process.env.XDG_RUNTIME_DIR = join(out, 'no-such-dir');
        process.env.RCLONE_WEBDAV_URL = 'http://elsewhere/';
        try {
            const script = [
                "const fs = require('node:fs');",
                "fs.writeFileSync(process.env.OUT + '/config', fs.readFileSync('/dev/fd/3', 'utf8'));",
                "fs.writeFileSync(process.env.OUT + '/fd', fs.readlinkSync('/proc/self/fd/3'));",
                "fs.writeFileSync(process.env.OUT + '/env', JSON.stringify(process.env));",
            ].join('\n');
            const child = spawnRclone(process.execPath, ['-e', script], '[pdm]\ntype = webdav\n', { OUT: out, RCLONE_WEBDAV_BEARER_TOKEN: 't' });
            expect(await child.exited).toBe(0);
            expect(readFileSync(join(out, 'config'), 'utf8')).toBe('[pdm]\ntype = webdav\n');
            expect(readFileSync(join(out, 'fd'), 'utf8')).toEndWith('(deleted)');
            const env = JSON.parse(readFileSync(join(out, 'env'), 'utf8'));
            expect(env).toMatchObject({ RCLONE_CONFIG: '/dev/fd/3', RCLONE_WEBDAV_BEARER_TOKEN: 't' });
            expect(env.RCLONE_WEBDAV_URL).toBeUndefined();
        } finally {
            for (const [name, value] of [['XDG_RUNTIME_DIR', saved.runtime], ['RCLONE_WEBDAV_URL', saved.url]] as const) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });
});

describe('rcloneEnv', () => {
    test("adds the credential and the config file, and drops the user's own settings for WebDAV and for remotes", () => {
        const env = rcloneEnv(
            { PATH: '/bin', RCLONE_WEBDAV_URL: 'http://x/', RCLONE_WEBDAV_BEARER_TOKEN: 'old', RCLONE_CONFIG_PDM_TYPE: 'local', RCLONE_CONFIG: '/c', RCLONE_VERBOSE: '1' },
            { RCLONE_WEBDAV_BEARER_TOKEN: 'new' },
        );
        expect(env).toEqual({ PATH: '/bin', RCLONE_VERBOSE: '1', RCLONE_WEBDAV_BEARER_TOKEN: 'new', RCLONE_CONFIG: '/dev/fd/3' });
    });
});

describe('rcloneConfig', () => {
    test('defines the pdm remote as the serve at its URL, of vendor rclone (so a same-size remote edit shows), and holds no credential', () => {
        expect(rcloneConfig(new URL('http://127.0.0.1:7395/'))).toBe(['[pdm]', 'type = webdav', 'url = http://127.0.0.1:7395/', 'vendor = rclone', ''].join('\n'));
    });
});

describe('cacheFolder', () => {
    test('names the folder rclone 1.75 keeps the cache in when its environment sets the credential', () => {
        // Seen with `rclone lsd pdm: -vv`: "detected overridden config - adding {E_Y5p} suffix".
        expect(cacheFolder('aaa')).toBe('pdm{E_Y5p}');
        expect(cacheFolder('bbb')).toBe('pdm{gQ7ev}');
    });
});

const ENV = { HOME: '/home/u' };

describe('cacheSettings', () => {
    test("fills the defaults for what the user left out, with rclone's own cache folder", () => {
        expect(cacheSettings({}, ENV)).toEqual({ ...DEFAULT_CACHE, cacheDir: '/home/u/.cache/rclone' });
        expect(cacheSettings({}, { ...ENV, XDG_CACHE_HOME: '/xdg' })).toEqual({ ...DEFAULT_CACHE, cacheDir: '/xdg/rclone' });
        expect(cacheSettings({ 'vfs-cache-max-size': '1G' }, ENV)).toEqual({ ...DEFAULT_CACHE, vfsCacheMaxSize: '1G', cacheDir: '/home/u/.cache/rclone' });
    });

    test("takes rclone's own RCLONE_CACHE_DIR when the user gives no --cache-dir", () => {
        expect(cacheSettings({}, { ...ENV, XDG_CACHE_HOME: '/xdg', RCLONE_CACHE_DIR: '/rc' })).toEqual({ ...DEFAULT_CACHE, cacheDir: '/rc' });
        expect(cacheSettings({ 'cache-dir': '/flag' }, { ...ENV, RCLONE_CACHE_DIR: '/rc' })).toEqual({ ...DEFAULT_CACHE, cacheDir: '/flag' });
    });

    test('takes the durations, sizes and directories rclone takes', () => {
        for (const time of ['5s', '30s', '1h30m', '500ms', '1.5h', '2d', '0s']) {
            expect(cacheSettings({ 'dir-cache-time': time }, ENV)).toMatchObject({ dirCacheTime: time });
        }
        for (const size of ['1G', '512M', '100k', '1.5G', 'off', '1024']) {
            expect(cacheSettings({ 'vfs-cache-max-size': size }, ENV)).toMatchObject({ vfsCacheMaxSize: size });
        }
        expect(cacheSettings({ 'cache-dir': '/data/cache' }, ENV)).toEqual({ ...DEFAULT_CACHE, cacheDir: '/data/cache' });
        expect(cacheSettings({ 'cache-dir': 'rel' }, ENV)).toMatchObject({ cacheDir: join(process.cwd(), 'rel') });
    });

    test('refuses a value rclone would not read, naming the flag', () => {
        for (const [flag, value] of [
            ['dir-cache-time', 'banana'],
            ['dir-cache-time', ''],
            ['dir-cache-time', '5'],
            ['dir-cache-time', '-5s'],
            ['vfs-cache-max-size', 'big'],
            ['vfs-cache-max-size', ''],
            ['vfs-cache-max-size', '1X'],
            ['cache-dir', ''],
        ] as const) {
            const settings = cacheSettings({ [flag]: value }, ENV);
            expect(typeof settings).toBe('string');
            expect(settings).toContain(`--${flag}`);
        }
    });
});

/** A cache folder holding rclone's record and content of each file, dirty or not, under `folder`. */
/** The owner of the cache folders of a mount with state dir /s and no --root, as BASE has. */
const OWNER = cacheOwner('/s', undefined);

/** A cache dir with `files` in `folder`, dirty or not, and `owner` marked as the mount that made the folder. */
function cacheWith(files: Record<string, boolean>, folder = 'pdm', dir = mkdtempSync(join(tmpdir(), 'pdm-cache-')), owner = OWNER): string {
    mkdirSync(join(dir, 'proton-drive-mount'), { recursive: true });
    writeFileSync(join(dir, 'proton-drive-mount', folder), owner);
    for (const [path, dirty] of Object.entries(files)) {
        const meta = join(dir, 'vfsMeta', folder, path);
        mkdirSync(dirname(meta), { recursive: true });
        writeFileSync(meta, JSON.stringify({ ModTime: '2026-11-11T00:00:00Z', Size: 1, Rs: [], Fingerprint: '', Dirty: dirty }));
        const content = join(dir, 'vfs', folder, path);
        mkdirSync(dirname(content), { recursive: true });
        writeFileSync(content, `${folder}:${path}`);
    }
    return dir;
}

describe('pendingWrites', () => {
    test('counts a file with a record cut short as pending when all of its content is on disk, at a whole block too', () => {
        const dir = cacheWith({ 'block.bin': true }, 'pdm{x}');
        writeFileSync(join(dir, 'vfs', 'pdm{x}', 'block.bin'), Buffer.from(Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256))));
        writeFileSync(join(dir, 'vfsMeta', 'pdm{x}', 'block.bin'), '');
        expect(statSync(join(dir, 'vfs', 'pdm{x}', 'block.bin')).blocks * 512).toBe(4096);
        expect(pendingWrites(dir, 'pdm{x}')).toEqual(['block.bin']);
    });

    test('does not count a file whose record does not say Dirty', () => {
        const dir = cacheWith({ 'a.txt': true }, 'pdm{x}');
        writeFileSync(join(dir, 'vfsMeta', 'pdm{x}', 'a.txt'), JSON.stringify({ Size: 1 }));
        expect(pendingWrites(dir, 'pdm{x}')).toEqual([]);
    });

    test('lists the files rclone has not yet uploaded, by their path in the Drive', () => {
        const dir = cacheWith({ 'Photos/new.jpg': true, 'Photos/old.jpg': false, 'a b.txt': true }, 'pdm{x}');
        expect(pendingWrites(dir, 'pdm{x}')).toEqual(['Photos/new.jpg', 'a b.txt']);
    });

    test('lists nothing when rclone has no record yet', () => {
        expect(pendingWrites(join(tmpdir(), 'pdm-no-such-cache'), 'pdm')).toEqual([]);
    });

    test('skips a record it cannot read', () => {
        const dir = cacheWith({ 'ok.txt': true });
        writeFileSync(join(dir, 'vfsMeta', 'pdm', 'torn.txt'), '{"Dirty": tr');
        expect(pendingWrites(dir, 'pdm')).toEqual(['ok.txt']);
    });

    test('lists a file whose record a stop cut short when all its content is on disk, and not one only partly fetched', () => {
        const dir = cacheWith({ 'written.txt': true, 'fetched.bin': false });
        writeFileSync(join(dir, 'vfsMeta', 'pdm', 'written.txt'), '');
        writeFileSync(join(dir, 'vfsMeta', 'pdm', 'fetched.bin'), '');
        writeFileSync(join(dir, 'vfs', 'pdm', 'fetched.bin'), '');
        truncateSync(join(dir, 'vfs', 'pdm', 'fetched.bin'), 1 << 20);
        expect(pendingWrites(dir, 'pdm')).toEqual(['written.txt']);
    });
});

describe('adoptPendingWrites', () => {
    test("moves the files earlier mounts left un-uploaded into this mount's folder, and drops the rest of their cache", () => {
        const dir = cacheWith({ 'Photos/new.jpg': true, 'Photos/old.jpg': false }, 'pdm{old}');
        cacheWith({ 'b.txt': true }, 'pdm{older}', dir);
        expect(adoptPendingWrites(dir, 'pdm{new}', OWNER)).toEqual({ moved: ['Photos/new.jpg', 'b.txt'], kept: [] });
        expect(pendingWrites(dir, 'pdm{new}')).toEqual(['Photos/new.jpg', 'b.txt']);
        expect(readFileSync(join(dir, 'vfs', 'pdm{new}', 'Photos/new.jpg'), 'utf8')).toBe('pdm{old}:Photos/new.jpg');
        for (const old of ['pdm{old}', 'pdm{older}']) {
            expect(existsSync(join(dir, 'vfs', old))).toBe(false);
            expect(existsSync(join(dir, 'vfsMeta', old))).toBe(false);
        }
    });

    test('takes over only the folders of a mount with the same state dir and --root, and leaves those of other accounts, roots and unknown mounts', () => {
        const dir = cacheWith({ 'mine.txt': true }, 'pdm{mine}');
        cacheWith({ 'theirs.txt': true }, 'pdm{account}', dir, cacheOwner('/other', undefined));
        cacheWith({ 'root.txt': true }, 'pdm{root}', dir, cacheOwner('/s', 'B'));
        cacheWith({ 'unknown.txt': true }, 'pdm{unknown}', dir);
        rmSync(join(dir, 'proton-drive-mount', 'pdm{unknown}'));
        expect(adoptPendingWrites(dir, 'pdm{new}', OWNER)).toEqual({ moved: ['mine.txt'], kept: [] });
        expect(pendingWrites(dir, 'pdm{account}')).toEqual(['theirs.txt']);
        expect(pendingWrites(dir, 'pdm{root}')).toEqual(['root.txt']);
        expect(pendingWrites(dir, 'pdm{unknown}')).toEqual(['unknown.txt']);
        expect(existsSync(join(dir, 'proton-drive-mount', 'pdm{mine}'))).toBe(false);
        expect(readFileSync(join(dir, 'proton-drive-mount', 'pdm{new}'), 'utf8')).toBe(OWNER);
    });

    test('names the owner by the state dir and the --root, whatever the slashes', () => {
        expect(cacheOwner('/s', undefined)).toBe(cacheOwner('/s/', ''));
        expect(cacheOwner('/s', 'Photos/immich')).toBe(cacheOwner('/s', '/Photos/immich/'));
        expect(cacheOwner('/s', 'Photos')).not.toBe(cacheOwner('/s', undefined));
        expect(cacheOwner('/s', undefined)).not.toBe(cacheOwner('/t', undefined));
    });

    test('moves a good record as it is, and gives a rewritten record the modification time of the content', () => {
        const dir = cacheWith({ 'good.txt': true, 'torn.txt': true }, 'pdm{old}');
        const good = JSON.stringify({ ModTime: '2020-01-02T03:04:05Z', ATime: '2020-01-02T03:04:05Z', Size: 1, Rs: [], Fingerprint: 'f', Dirty: true });
        writeFileSync(join(dir, 'vfsMeta', 'pdm{old}', 'good.txt'), good);
        writeFileSync(join(dir, 'vfsMeta', 'pdm{old}', 'torn.txt'), '');
        const when = new Date('2025-06-07T08:09:10Z');
        utimesSync(join(dir, 'vfs', 'pdm{old}', 'torn.txt'), when, when);
        adoptPendingWrites(dir, 'pdm{new}', OWNER);
        expect(readFileSync(join(dir, 'vfsMeta', 'pdm{new}', 'good.txt'), 'utf8')).toBe(good);
        expect(JSON.parse(readFileSync(join(dir, 'vfsMeta', 'pdm{new}', 'torn.txt'), 'utf8')).ModTime).toBe(when.toISOString());
    });

    test('starts even when it cannot delete the rest of an earlier folder', () => {
        const dir = cacheWith({ 'new.txt': true, 'Locked/old.txt': false }, 'pdm{old}');
        chmodSync(join(dir, 'vfs', 'pdm{old}', 'Locked'), 0o555);
        try {
            expect(adoptPendingWrites(dir, 'pdm{new}', OWNER)).toEqual({ moved: ['new.txt'], kept: [] });
        } finally {
            chmodSync(join(dir, 'vfs', 'pdm{old}', 'Locked'), 0o755);
        }
    });

    test("leaves the cache of a remote the user named pdm, or any other remote, alone", () => {
        const dir = cacheWith({ 'mine.txt': true }, 'pdm');
        cacheWith({ 'other.txt': true }, 'pdmx', dir);
        cacheWith({ 'other.txt': true }, 'pdmx{abcde}', dir);
        expect(adoptPendingWrites(dir, 'pdm{new}', OWNER)).toEqual({ moved: [], kept: [] });
        expect(pendingWrites(dir, 'pdm')).toEqual(['mine.txt']);
        expect(pendingWrites(dir, 'pdmx')).toEqual(['other.txt']);
        expect(pendingWrites(dir, 'pdmx{abcde}')).toEqual(['other.txt']);
    });

    test('rewrites a record a stop cut short, so rclone uploads the file and does not drop it', () => {
        const dir = cacheWith({ 'there.txt': true }, 'pdm{old}');
        writeFileSync(join(dir, 'vfsMeta', 'pdm{old}', 'there.txt'), '{"ModTi');
        expect(adoptPendingWrites(dir, 'pdm{new}', OWNER)).toEqual({ moved: ['there.txt'], kept: [] });
        const size = 'pdm{old}:there.txt'.length;
        const record = JSON.parse(readFileSync(join(dir, 'vfsMeta', 'pdm{new}', 'there.txt'), 'utf8'));
        expect(record).toMatchObject({ Size: size, Rs: [{ Pos: 0, Size: size }], Fingerprint: '', Dirty: true });
        expect(Number.isNaN(Date.parse(record.ModTime))).toBe(false);
    });

    test('keeps a file it cannot move, and the folder it is in, and moves the rest', () => {
        const dir = cacheWith({ 'gone.txt': true, 'ok.txt': true }, 'pdm{old}');
        rmSync(join(dir, 'vfs', 'pdm{old}', 'gone.txt'));
        writeFileSync(join(dir, 'vfsMeta', 'pdm{old}', 'gone.txt'), JSON.stringify({ Size: 1, Dirty: true }));
        const { moved, kept } = adoptPendingWrites(dir, 'pdm{new}', OWNER);
        expect(moved).toEqual(['ok.txt']);
        expect(kept.map((entry) => entry.file)).toEqual([join(dir, 'vfs', 'pdm{old}', 'gone.txt')]);
        expect(kept[0]!.reason).toContain('ENOENT');
        expect(existsSync(join(dir, 'vfsMeta', 'pdm{old}', 'gone.txt'))).toBe(true);
        expect(pendingWrites(dir, 'pdm{new}')).toEqual(['ok.txt']);
    });

    test('moves nothing from a cache folder with no earlier mount', () => {
        expect(adoptPendingWrites(join(tmpdir(), 'pdm-no-such-cache'), 'pdm{new}', OWNER)).toEqual({ moved: [], kept: [] });
    });
});

/** A serve that reports it listens and then runs until its signal aborts. */
function fakeServe(order: string[], listensAt = 'http://127.0.0.1:4242/') {
    return async (options: ServeOptions & { onListening?: (url: URL) => void }) => {
        order.push('serve starts');
        options.onListening?.(new URL(listensAt));
        await new Promise<void>((resolve) => options.signal!.addEventListener('abort', () => resolve(), { once: true }));
        order.push('serve stops');
        return 0;
    };
}

interface RcloneCall {
    args: string[];
    config?: string;
    env?: Record<string, string>;
}

/** An rclone that runs until it is asked to stop. */
function fakeRclone(order: string[], calls: RcloneCall[]) {
    return (_exe: string, args: string[], config: string, env: Record<string, string>): RcloneProcess => {
        calls.push({ args, config, env });
        order.push('rclone starts');
        let done!: (code: number) => void;
        const exited = new Promise<number>((resolve) => (done = resolve));
        return {
            exited,
            stop: () => {
                order.push('rclone stops');
                done(0);
            },
        };
    };
}

const BASE = { stateDir: '/s', host: '127.0.0.1', port: 0, logger: QUIET, mountpoint: '/mnt/x', cache: CACHE };

/** A mountpoint that is ready as it is. */
const READY = async () => undefined;

describe('mountCommand', () => {
    test('starts the serve, then rclone against its URL, and on the signal stops rclone before the serve', async () => {
        const order: string[] = [];
        const calls: RcloneCall[] = [];
        const abort = new AbortController();
        const running = mountCommand(
            { ...BASE, signal: abort.signal },
            { serve: fakeServe(order), startRclone: fakeRclone(order, calls), rclone: 'rclone', prepareMountpoint: READY },
        );
        await new Promise((r) => setTimeout(r, 10));
        abort.abort();
        expect(await running).toBe(0);
        expect(order).toEqual(['serve starts', 'rclone starts', 'rclone stops', 'serve stops']);
        expect(calls[0]!.config).toContain('url = http://127.0.0.1:4242/');
        expect(calls[0]!.args[2]).toBe('/mnt/x');
    });

    test('stops the serve and fails when rclone ends on its own', async () => {
        const order: string[] = [];
        const result = await mountCommand(
            { ...BASE },
            {
                serve: fakeServe(order),
                rclone: 'rclone',
                prepareMountpoint: READY,
                startRclone: () => ({ exited: Promise.resolve(1), stop: () => {} }),
            },
        );
        expect(result).toBe(1);
        expect(order).toEqual(['serve starts', 'serve stops']);
    });

    test('stops rclone and passes on the needs-login status 3 when the serve ends with it', async () => {
        const order: string[] = [];
        const calls: { args: string[] }[] = [];
        const result = await mountCommand(
            { ...BASE },
            {
                serve: async (options) => {
                    options.onListening?.(new URL('http://127.0.0.1:4242/'));
                    await new Promise((r) => setTimeout(r, 10));
                    return 3;
                },
                rclone: 'rclone',
                startRclone: fakeRclone(order, calls),
                prepareMountpoint: READY,
            },
        );
        expect(result).toBe(3);
        expect(order).toEqual(['rclone starts', 'rclone stops']);
    });

    test('gives the serve a fresh credential and rclone the same one in its environment, never in its arguments or config', async () => {
        const credentials: (string | undefined)[] = [];
        const calls: RcloneCall[] = [];
        for (let run = 0; run < 2; run++) {
            const abort = new AbortController();
            const running = mountCommand(
                { ...BASE, signal: abort.signal },
                {
                    serve: async (options) => {
                        credentials.push(options.credential);
                        return fakeServe([])(options);
                    },
                    startRclone: fakeRclone([], calls),
                    rclone: 'rclone',
                    prepareMountpoint: READY,
                },
            );
            await new Promise((r) => setTimeout(r, 10));
            abort.abort();
            await running;
        }
        const [first, second] = credentials;
        expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(second).not.toBe(first);
        expect(calls.map((call) => call.env)).toEqual(credentials.map((credential) => ({ RCLONE_WEBDAV_BEARER_TOKEN: credential! })));
        expect(calls.map((call) => call.config)).toEqual(credentials.map(() => rcloneConfig(new URL('http://127.0.0.1:4242/'))));
        for (const [at, call] of calls.entries()) expect(call.args.join(' ')).not.toContain(credentials[at]!);
    });

    test('before rclone starts, takes over the files an earlier mount left, and after rclone ends, warns of each one not yet on the Drive', async () => {
        const warnings: string[] = [];
        const infos: string[] = [];
        const logger: Logger = {
            ...QUIET,
            info: (message: string) => void infos.push(message),
            warn: (message: string) => void warnings.push(message),
        };
        const cacheDir = cacheWith({ 'Photos/new.jpg': true, 'Photos/old.jpg': false, 'gone.txt': true }, 'pdm{earlier}');
        rmSync(join(cacheDir, 'vfs', 'pdm{earlier}', 'gone.txt'));
        const order: string[] = [];
        const atStart: { pending: string[]; warnings: number }[] = [];
        const rclone = fakeRclone(order, []);
        const abort = new AbortController();
        const running = mountCommand(
            { ...BASE, logger, cache: { ...CACHE, cacheDir }, signal: abort.signal },
            {
                serve: fakeServe(order),
                startRclone: (exe, args, config, env) => {
                    atStart.push({ pending: pendingWrites(cacheDir, cacheFolder(env.RCLONE_WEBDAV_BEARER_TOKEN!)), warnings: warnings.length });
                    return rclone(exe, args, config, env);
                },
                rclone: 'rclone',
                prepareMountpoint: READY,
            },
        );
        await new Promise((r) => setTimeout(r, 10));
        abort.abort();
        expect(await running).toBe(0);
        expect(infos).toContain('Photos/new.jpg, left by an earlier mount, uploads now.');
        expect(order.indexOf('rclone starts')).toBeGreaterThan(-1);
        expect(atStart).toEqual([{ pending: ['Photos/new.jpg'], warnings: 1 }]);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toStartWith(`${join(cacheDir, 'vfs', 'pdm{earlier}', 'gone.txt')} was left by an earlier mount and is not on the Drive, but the mount could not take it over: ENOENT`);
        expect(warnings[1]).toBe('Photos/new.jpg is not yet on the Drive. The next mount with this cache folder, state dir and root uploads it.');
    });

    test('returns the serve code without starting rclone when the serve ends before it listens', async () => {
        const calls: { args: string[] }[] = [];
        const result = await mountCommand(
            { ...BASE },
            { serve: async () => 1, rclone: 'rclone', startRclone: fakeRclone([], calls), prepareMountpoint: READY },
        );
        expect(result).toBe(1);
        expect(calls).toEqual([]);
    });

    test.each([1, 2])('checks the mountpoint first, and on a refusal with exit %d starts neither the serve nor rclone', async (code) => {
        const order: string[] = [];
        const calls: { args: string[] }[] = [];
        const checked: string[] = [];
        const result = await mountCommand(
            { ...BASE },
            {
                serve: fakeServe(order),
                rclone: 'rclone',
                startRclone: fakeRclone(order, calls),
                prepareMountpoint: async (path) => {
                    checked.push(path);
                    return { code, message: `Cannot use ${path}` };
                },
            },
        );
        expect(result).toBe(code);
        expect(checked).toEqual(['/mnt/x']);
        expect(order).toEqual([]);
    });
});
