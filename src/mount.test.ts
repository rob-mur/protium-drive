import { describe, expect, test } from 'bun:test';

import { createLogger } from './logger.ts';
import { cacheSettings, DEFAULT_CACHE, mountCommand, rcloneArgs, RCLONE_SETTINGS, type RcloneProcess } from './mount.ts';
import type { ServeOptions } from './serve.ts';

const QUIET = createLogger({ PDM_LOG_LEVEL: 'error' });

describe('rcloneArgs', () => {
    test('mounts the serve as a :webdav: remote of vendor other, with the tested settings', () => {
        const args = rcloneArgs('/mnt/drive', new URL('http://127.0.0.1:7395/'), DEFAULT_CACHE);
        expect(args.slice(0, 3)).toEqual(['mount', ':webdav:', '/mnt/drive']);
        expect(args).toContain('--webdav-url=http://127.0.0.1:7395/');
        expect(args).toContain('--webdav-vendor=other');
        for (const [flag, value] of RCLONE_SETTINGS) {
            const at = args.indexOf(flag);
            expect(at).toBeGreaterThan(-1);
            if (value !== undefined) expect(args[at + 1]).toBe(value);
        }
    });

    test('without cache settings, carries the documented defaults for a multi-device mount', () => {
        const args = rcloneArgs('/m', new URL('http://127.0.0.1:1/'), DEFAULT_CACHE).join(' ');
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
        expect(args).not.toContain('--cache-dir');
    });

    test('passes the cache settings the user gave', () => {
        const args = rcloneArgs('/m', new URL('http://127.0.0.1:1/'), {
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

describe('cacheSettings', () => {
    test('fills the defaults for what the user left out', () => {
        expect(cacheSettings({})).toEqual(DEFAULT_CACHE);
        expect(cacheSettings({ 'vfs-cache-max-size': '1G' })).toEqual({ ...DEFAULT_CACHE, vfsCacheMaxSize: '1G' });
    });

    test('takes the durations, sizes and directories rclone takes', () => {
        for (const time of ['5s', '30s', '1h30m', '500ms', '1.5h', '2d', '0s']) {
            expect(cacheSettings({ 'dir-cache-time': time })).toEqual({ ...DEFAULT_CACHE, dirCacheTime: time });
        }
        for (const size of ['1G', '512M', '100k', '1.5G', 'off', '1024']) {
            expect(cacheSettings({ 'vfs-cache-max-size': size })).toEqual({ ...DEFAULT_CACHE, vfsCacheMaxSize: size });
        }
        expect(cacheSettings({ 'cache-dir': '/data/cache' })).toEqual({ ...DEFAULT_CACHE, cacheDir: '/data/cache' });
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
            const settings = cacheSettings({ [flag]: value });
            expect(typeof settings).toBe('string');
            expect(settings).toContain(`--${flag}`);
        }
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

/** An rclone that runs until it is asked to stop. */
function fakeRclone(order: string[], calls: { args: string[]; env?: Record<string, string> }[]) {
    return (_exe: string, args: string[], env?: Record<string, string>): RcloneProcess => {
        calls.push({ args, env });
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

const BASE = { stateDir: '/s', host: '127.0.0.1', port: 0, logger: QUIET, mountpoint: '/mnt/x' };

/** A mountpoint that is ready as it is. */
const READY = async () => undefined;

describe('mountCommand', () => {
    test('starts the serve, then rclone against its URL, and on the signal stops rclone before the serve', async () => {
        const order: string[] = [];
        const calls: { args: string[] }[] = [];
        const abort = new AbortController();
        const running = mountCommand(
            { ...BASE, signal: abort.signal },
            { serve: fakeServe(order), startRclone: fakeRclone(order, calls), rclone: 'rclone', prepareMountpoint: READY },
        );
        await new Promise((r) => setTimeout(r, 10));
        abort.abort();
        expect(await running).toBe(0);
        expect(order).toEqual(['serve starts', 'rclone starts', 'rclone stops', 'serve stops']);
        expect(calls[0]!.args).toContain('--webdav-url=http://127.0.0.1:4242/');
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

    test('gives the serve a fresh credential and rclone the same one in its environment, never in its arguments', async () => {
        const credentials: (string | undefined)[] = [];
        const calls: { args: string[]; env?: Record<string, string> }[] = [];
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
        expect(calls.map((call) => call.env?.RCLONE_WEBDAV_BEARER_TOKEN)).toEqual(credentials);
        for (const call of calls) expect(call.args.join(' ')).not.toContain(call.env!.RCLONE_WEBDAV_BEARER_TOKEN!);
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
