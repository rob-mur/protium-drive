import { describe, expect, test } from 'bun:test';

import { createLogger } from './logger.ts';
import { mountCommand, rcloneArgs, RCLONE_SETTINGS, type RcloneProcess } from './mount.ts';
import type { ServeOptions } from './serve.ts';

const QUIET = createLogger({ PDM_LOG_LEVEL: 'error' });

describe('rcloneArgs', () => {
    test('mounts the serve as a :webdav: remote of vendor other, with the tested settings', () => {
        const args = rcloneArgs('/mnt/drive', new URL('http://127.0.0.1:7395/'));
        expect(args.slice(0, 3)).toEqual(['mount', ':webdav:', '/mnt/drive']);
        expect(args).toContain('--webdav-url=http://127.0.0.1:7395/');
        expect(args).toContain('--webdav-vendor=other');
        for (const [flag, value] of RCLONE_SETTINGS) {
            const at = args.indexOf(flag);
            expect(at).toBeGreaterThan(-1);
            if (value !== undefined) expect(args[at + 1]).toBe(value);
        }
    });

    test('carries every setting #25 names', () => {
        const args = rcloneArgs('/m', new URL('http://127.0.0.1:1/')).join(' ');
        for (const setting of [
            '--vfs-cache-mode full',
            '--vfs-cache-max-size 6G',
            '--vfs-write-back 5s',
            '--dir-cache-time 1000h',
            '--attr-timeout 1000h',
            '--no-modtime',
            '--no-checksum',
            '--timeout 1h',
            '--transfers 2',
        ]) {
            expect(args).toContain(setting);
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
function fakeRclone(order: string[], calls: { args: string[] }[]) {
    return (_exe: string, args: string[]): RcloneProcess => {
        calls.push({ args });
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

describe('mountCommand', () => {
    test('starts the serve, then rclone against its URL, and on the signal stops rclone before the serve', async () => {
        const order: string[] = [];
        const calls: { args: string[] }[] = [];
        const abort = new AbortController();
        const running = mountCommand(
            { ...BASE, signal: abort.signal },
            { serve: fakeServe(order), startRclone: fakeRclone(order, calls), rclone: 'rclone' },
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
                startRclone: () => ({ exited: Promise.resolve(1), stop: () => {} }),
            },
        );
        expect(result).toBe(1);
        expect(order).toEqual(['serve starts', 'serve stops']);
    });

    test('returns the serve code without starting rclone when the serve ends before it listens', async () => {
        const calls: { args: string[] }[] = [];
        const result = await mountCommand(
            { ...BASE },
            { serve: async () => 1, rclone: 'rclone', startRclone: fakeRclone([], calls) },
        );
        expect(result).toBe(1);
        expect(calls).toEqual([]);
    });
});
