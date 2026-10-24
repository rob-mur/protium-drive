import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type Harness, startHarness } from '../support/harness';

/**
 * Runs stock rclone (webdav backend, vendor = other) against the real server
 * backed by the fake SDK. Nothing here talks to Proton.
 */
const RCLONE = Bun.which('rclone');

let h: Harness;
let dir: string;
let config: string;

beforeAll(async () => {
    if (!RCLONE) {
        throw new Error('rclone is not on PATH. Run the tests inside "nix develop", or install rclone.');
    }
    h = startHarness();
    dir = await mkdtemp(path.join(tmpdir(), 'pdm-rclone-'));
    config = path.join(dir, 'rclone.conf');
    await writeFile(config, `[pdm]\ntype = webdav\nurl = ${h.url('/')}\nvendor = other\n`);
});

afterAll(async () => {
    await h?.stop();
    if (dir) {
        await rm(dir, { recursive: true, force: true });
    }
});

async function rclone(...args: string[]): Promise<{ code: number; stdout: Uint8Array<ArrayBuffer>; stderr: string }> {
    const proc = Bun.spawn([RCLONE!, '--config', config, '--retries', '1', '--low-level-retries', '1', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, RCLONE_CONFIG: config },
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).bytes(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { code, stdout, stderr };
}

async function ok(...args: string[]): Promise<string> {
    const result = await rclone(...args);
    if (result.code !== 0) {
        throw new Error(`rclone ${args.join(' ')} failed (${result.code}):\n${result.stderr}`);
    }
    return new TextDecoder().decode(result.stdout);
}

function pattern(size: number, seed: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        data[i] = (i * 31 + seed) & 0xff;
    }
    return data;
}

describe('stock rclone webdav against the fake-backed server', () => {
    test('list, copy in, overwrite, read back, delete', async () => {
        h.fake.remoteWrite('existing/hello.txt', 'hello from drive');

        expect((await ok('lsf', 'pdm:')).trim().split('\n')).toEqual(['existing/']);
        expect((await ok('lsf', 'pdm:existing')).trim()).toBe('hello.txt');
        expect(await ok('cat', 'pdm:existing/hello.txt')).toBe('hello from drive');

        // Copy in.
        const local = path.join(dir, 'photo.jpg');
        const first = pattern(1_500_000, 1);
        await writeFile(local, first);
        await ok('copyto', local, 'pdm:upload/photo.jpg');
        expect(h.fake.byPath('upload/photo.jpg').content).toEqual(first);
        expect((await ok('lsl', 'pdm:upload')).trim()).toMatch(/^\s*1500000 .* photo\.jpg$/);

        // Overwrite: a new revision of the same Drive file.
        const second = pattern(900_000, 2);
        await writeFile(local, second);
        await ok('copyto', local, 'pdm:upload/photo.jpg');
        const node = h.fake.byPath('upload/photo.jpg');
        expect(node.revision).toBe(2);
        expect(node.content).toEqual(second);

        // Read back, whole and as a range.
        const back = path.join(dir, 'back.jpg');
        await ok('copyto', 'pdm:upload/photo.jpg', back);
        expect(new Uint8Array(await Bun.file(back).arrayBuffer())).toEqual(second);
        const range = await rclone('cat', '--offset', '500000', '--count', '1000', 'pdm:upload/photo.jpg');
        expect(range.code).toBe(0);
        expect(range.stdout).toEqual(second.slice(500_000, 501_000));

        // Rename, then delete (to the trash).
        await ok('moveto', 'pdm:upload/photo.jpg', 'pdm:upload/renamed.jpg');
        expect((await ok('lsf', 'pdm:upload')).trim()).toBe('renamed.jpg');
        await ok('deletefile', 'pdm:upload/renamed.jpg');
        expect((await ok('lsf', 'pdm:upload')).trim()).toBe('');
        expect(h.fake.trashedNames()).toEqual(['renamed.jpg']);

        expect(h.fake.activeDownloads).toBe(0);
    }, 60_000);

    test('uploads larger than Bun’s default 128 MiB body limit', async () => {
        const size = 130 * 1024 * 1024;
        const local = path.join(dir, 'large.bin');
        await writeFile(local, pattern(size, 3));
        await ok('copyto', local, 'pdm:large/large.bin');
        expect(h.fake.byPath('large/large.bin').content?.length).toBe(size);
        expect((await ok('size', '--json', 'pdm:large')).replace(/\s/g, '')).toContain(`"bytes":${size}`);
        await rm(local);
    }, 120_000);
});
