import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';

import { afterEach, describe, expect, test } from 'bun:test';

import { acquireStateLock } from './lock.ts';

const DIRS: string[] = [];

function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pdm-lock-XXXXXX'));
    DIRS.push(dir);
    return dir;
}

afterEach(async () => {
    while (DIRS.length) {
        await rm(DIRS.pop()!, { recursive: true, force: true }).catch(() => {});
    }
});

describe('acquireStateLock', () => {
    test('one lock per state directory: a second acquire names the holder and its state dir', async () => {
        const stateDir = scratch();
        const release = await acquireStateLock(stateDir);
        expect(await readFile(`${stateDir}/lock.pid`, 'utf8')).toBe(`${process.pid}\n`);
        let error: unknown;
        try {
            await acquireStateLock(stateDir);
        } catch (caught: unknown) {
            error = caught;
        }
        expect(String(error)).toContain(`pid ${process.pid}`);
        expect(String(error)).toContain(stateDir);
        await release();
        // Released: the next acquire wins.
        const second = await acquireStateLock(stateDir);
        await second();
    });

    test('a lock left by a dead process is taken over', async () => {
        const stateDir = scratch();
        const { writeFile } = await import('node:fs/promises');
        await writeFile(`${stateDir}/lock.pid`, '999999999\n', { mode: 0o600 });
        const release = await acquireStateLock(stateDir);
        expect(await readFile(`${stateDir}/lock.pid`, 'utf8')).toBe(`${process.pid}\n`);
        await release();
    });

    test('releasing removes the lock file', async () => {
        const stateDir = scratch();
        const release = await acquireStateLock(stateDir);
        await release();
        expect(await readFile(`${stateDir}/lock.pid`, 'utf8').catch(() => 'gone')).toBe('gone');
    });
});
