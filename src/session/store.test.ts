import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { SESSION_FILE_NAME, SessionFileStore, type StoredSession } from './store.ts';

const DIRS: string[] = [];

afterEach(async () => {
    for (const dir of DIRS.splice(0)) {
        await chmod(dir, 0o700).catch(() => {});
        await Bun.$`rm -rf ${dir}`.quiet();
    }
});

function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pdm-store-XXXXXX'));
    DIRS.push(dir);
    return dir;
}

function snapshot(overrides: Partial<StoredSession> = {}): StoredSession {
    return {
        version: 1,
        appVersion: 'external-drive-protondrivemount@0.1.0-alpha',
        savedAt: '2026-11-01T00:00:00.000Z',
        userKeyPassword: 'key-password',
        session: { uid: 'session-1', accessToken: 'access-1-1', refreshToken: 'refresh-1' },
        ...overrides,
    };
}

describe('SessionFileStore', () => {
    test('load finds nothing before the first save', async () => {
        const store = new SessionFileStore(scratch());
        expect(await store.load()).toBeNull();
    });

    test('a save makes the directory 0700 and the file 0600, and load round-trips it', async () => {
        const stateDir = scratch();
        const store = new SessionFileStore(stateDir);
        const saved = snapshot();
        await store.save(saved);

        expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
        expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
        expect(await store.load()).toEqual(saved);
    });

    test('a save of an existing directory retightens loose permissions', async () => {
        const stateDir = scratch();
        const store = new SessionFileStore(stateDir);
        await store.save(snapshot());
        await chmod(stateDir, 0o755);
        await chmod(store.filePath, 0o644);

        await store.save(snapshot({ session: { uid: 'session-2', accessToken: 'access-2-1' } }));

        expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
        expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
        expect((await store.load())?.session.uid).toBe('session-2');
    });

    test('load tightens a session file that sits too loose', async () => {
        const stateDir = scratch();
        const store = new SessionFileStore(stateDir);
        await store.save(snapshot());
        await chmod(store.filePath, 0o644);

        await store.load();

        expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    });

    test('a save replaces the session whole and leaves no temporary file behind', async () => {
        const stateDir = scratch();
        const store = new SessionFileStore(stateDir);
        await store.save(snapshot({ userKeyPassword: 'old-key-password', session: { uid: 'session-1', accessToken: 'access-1-1' } }));
        const replacement = snapshot({ userKeyPassword: 'new-key-password', session: { uid: 'session-2', accessToken: 'access-2-1' } });

        await store.save(replacement);

        expect(await store.load()).toEqual(replacement);
        const raw = JSON.parse(await Bun.file(store.filePath).text()) as StoredSession;
        expect(raw.userKeyPassword).not.toContain('old');
        expect((await readdir(stateDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    test('a save goes through a temporary file, never straight onto the session file', async () => {
        // The rename is what makes a crash never leave half a session: the write
        // lands on a temporary path of its own, then replaces the session file.
        const stateDir = scratch();
        const store = new SessionFileStore(stateDir);
        const written: string[] = [];
        const realWrite = Bun.write;
        Bun.write = ((path: string, data: unknown, options?: unknown) => {
            written.push(path);
            return realWrite(path as never, data as never, options as never);
        }) as typeof Bun.write;
        try {
            await store.save(snapshot());
        } finally {
            Bun.write = realWrite;
        }
        expect(written.some((path) => path.startsWith(`${store.filePath}.`) && path.endsWith('.tmp'))).toBeTrue();
        expect(written.filter((path) => path === store.filePath)).toEqual([]);
    });

    test('load refuses a file that is not a known session format', async () => {
        const stateDir = scratch();
        const store = new SessionFileStore(stateDir);
        await mkdir(stateDir, { recursive: true });
        await writeFile(join(stateDir, SESSION_FILE_NAME), '{"version":99}');

        expect(store.load()).rejects.toThrow('not in a known format');
    });

    test('remove deletes the file and reports whether it was there', async () => {
        const stateDir = scratch();
        const store = new SessionFileStore(stateDir);
        expect(await store.remove()).toBeFalse();
        await store.save(snapshot());
        expect(await store.remove()).toBeTrue();
        expect(await Bun.file(store.filePath).exists()).toBeFalse();
    });
});
