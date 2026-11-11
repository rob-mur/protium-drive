import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fusermountUnmount, prepareMountpoint, type MountpointDeps } from './mountpoint.ts';

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pdm-mountpoint-'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** What a stat of a mountpoint a killed FUSE mount left answers. */
function notConnected(path: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`ENOTCONN: socket is not connected, stat '${path}'`), { code: 'ENOTCONN' });
}

/** Deps whose stat answers ENOTCONN until `unmount` runs, as a killed mount's folder does. */
function staleMount(unmountCode = 0) {
    const unmounted: string[] = [];
    let stale = true;
    const deps: MountpointDeps = {
        stat: async (path) => {
            if (stale) throw notConnected(path);
            return stat(path);
        },
        unmount: async (path) => {
            unmounted.push(path);
            if (unmountCode === 0) stale = false;
            return unmountCode;
        },
    };
    return { deps, unmounted };
}

const NEVER_UNMOUNT: MountpointDeps = {
    stat,
    unmount: async () => {
        throw new Error('unmount was not expected');
    },
};

describe('prepareMountpoint', () => {
    test('accepts an empty folder as it is', async () => {
        const folder = join(root, 'mnt');
        mkdirSync(folder);
        expect(await prepareMountpoint(folder, NEVER_UNMOUNT)).toBeUndefined();
        expect(readdirSync(folder)).toEqual([]);
    });

    test('creates a folder that does not exist, with its missing parents', async () => {
        const folder = join(root, 'a', 'b', 'mnt');
        expect(await prepareMountpoint(folder, NEVER_UNMOUNT)).toBeUndefined();
        expect(statSync(folder).isDirectory()).toBe(true);
        expect(readdirSync(folder)).toEqual([]);
    });

    test('refuses a folder that holds files with exit 2, names it, and leaves the files', async () => {
        const folder = join(root, 'mnt');
        mkdirSync(folder);
        writeFileSync(join(folder, 'notes.txt'), 'mine');
        const refusal = await prepareMountpoint(folder, NEVER_UNMOUNT);
        expect(refusal?.code).toBe(2);
        expect(refusal?.message).toContain(folder);
        expect(readdirSync(folder)).toEqual(['notes.txt']);
    });

    test('refuses a path that is a file with exit 2 and names it', async () => {
        const file = join(root, 'mnt');
        writeFileSync(file, 'mine');
        const refusal = await prepareMountpoint(file, NEVER_UNMOUNT);
        expect(refusal?.code).toBe(2);
        expect(refusal?.message).toContain(file);
    });

    test('unmounts a folder a killed mount left, then accepts it', async () => {
        const folder = join(root, 'mnt');
        mkdirSync(folder);
        const { deps, unmounted } = staleMount();
        expect(await prepareMountpoint(folder, deps)).toBeUndefined();
        expect(unmounted).toEqual([folder]);
    });

    test('still refuses a folder that holds files once the killed mount is gone', async () => {
        const folder = join(root, 'mnt');
        mkdirSync(folder);
        writeFileSync(join(folder, 'notes.txt'), 'mine');
        const { deps } = staleMount();
        const refusal = await prepareMountpoint(folder, deps);
        expect(refusal?.code).toBe(2);
        expect(refusal?.message).toContain(folder);
    });

    test('fails with exit 1 and names the folder when the killed mount cannot be unmounted', async () => {
        const folder = join(root, 'mnt');
        const { deps, unmounted } = staleMount(1);
        const refusal = await prepareMountpoint(folder, deps);
        expect(refusal?.code).toBe(1);
        expect(refusal?.message).toContain(folder);
        expect(unmounted).toEqual([folder]);
    });

    test('fails with exit 1 and names the folder on any other error, and unmounts nothing', async () => {
        const folder = join(root, 'mnt');
        const deps: MountpointDeps = {
            ...NEVER_UNMOUNT,
            stat: async () => {
                throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            },
        };
        const refusal = await prepareMountpoint(folder, deps);
        expect(refusal?.code).toBe(1);
        expect(refusal?.message).toContain(folder);
        expect(refusal?.message).toContain('EACCES');
    });

    test('fails with exit 1 and names the folder when it cannot create it', async () => {
        const folder = join(root, 'mnt');
        symlinkSync(join(root, 'gone'), folder);
        const refusal = await prepareMountpoint(folder, NEVER_UNMOUNT);
        expect(refusal?.code).toBe(1);
        expect(refusal?.message).toContain(`Cannot use ${folder} as the mountpoint`);
    });
});

describe('fusermountUnmount', () => {
    const path = process.env.PATH;
    afterEach(() => {
        process.env.PATH = path;
    });

    /** Puts a fusermount3 first on PATH that records its arguments and exits with `code`. */
    function fakeFusermount(code: number): string {
        const bin = join(root, 'bin');
        const log = join(root, 'args');
        mkdirSync(bin);
        writeFileSync(join(bin, 'fusermount3'), `#!/bin/sh\necho "$@" > '${log}'\nexit ${code}\n`, { mode: 0o755 });
        process.env.PATH = `${bin}:${path}`;
        return log;
    }

    test('unmounts lazily, so a shell still inside the killed mount does not make it busy', async () => {
        const log = fakeFusermount(0);
        expect(await fusermountUnmount('/mnt/x')).toBe(0);
        expect(readFileSync(log, 'utf8').trim()).toBe('-u -z /mnt/x');
    });

    test('gives the exit status of fusermount3', async () => {
        fakeFusermount(3);
        expect(await fusermountUnmount('/mnt/x')).toBe(3);
    });
});
