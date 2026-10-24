import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FileCredentials } from '../../src/session/credentials';
import { acquireStateLock } from '../../src/session/lock';
import { SessionFileStore } from '../../src/session/store';

let dir: string;

beforeEach(async () => {
    dir = path.join(await mkdtemp(path.join(tmpdir(), 'pdm-test-')), 'state');
});

afterEach(async () => {
    await rm(path.dirname(dir), { recursive: true, force: true });
});

async function signedIn(): Promise<FileCredentials> {
    const credentials = new FileCredentials(new SessionFileStore(dir), 'external-drive-test@1.0.0');
    await credentials.setUserKeyPassword('key-password');
    await credentials.setSessionInfo({ uid: 'uid-1', accessToken: 'access-1', refreshToken: 'refresh-1' });
    return credentials;
}

describe('session file', () => {
    test('is written with mode 0600 in a 0700 directory', async () => {
        await signedIn();
        const store = new SessionFileStore(dir);
        expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        const stored = await store.load();
        expect(stored?.session).toEqual({ uid: 'uid-1', accessToken: 'access-1', refreshToken: 'refresh-1' });
        expect(stored?.userKeyPassword).toBe('key-password');
        expect(stored?.appVersion).toBe('external-drive-test@1.0.0');
    });

    test('a restart loads the session, and a token refresh rewrites the file', async () => {
        await signedIn();
        const restarted = new FileCredentials(new SessionFileStore(dir), 'external-drive-test@1.0.0');
        await restarted.load();
        expect(restarted.isLoggedIn()).toBe(true);
        expect(restarted.refreshToken).toBe('refresh-1');

        await restarted.setSessionInfo({ uid: 'uid-1', accessToken: 'access-2', refreshToken: 'refresh-2' });
        expect((await new SessionFileStore(dir).load())?.session.refreshToken).toBe('refresh-2');
    });

    test('loosened permissions are tightened on load', async () => {
        await signedIn();
        const store = new SessionFileStore(dir);
        await Bun.$`chmod 644 ${store.filePath}`;
        await store.load();
        expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    });

    test('signOut from the account module keeps the file but marks it refused', async () => {
        const credentials = await signedIn();
        await credentials.signOut();
        expect(credentials.isLoggedIn()).toBe(false);
        const stored = await new SessionFileStore(dir).load();
        expect(stored?.refreshRejectedAt).toBeString();
        expect(stored?.session.refreshToken).toBe('refresh-1');

        const restarted = new FileCredentials(new SessionFileStore(dir), 'x');
        await restarted.load();
        expect(restarted.isLoggedIn()).toBe(false);
        expect(restarted.rejectedAt).toBe(stored!.refreshRejectedAt);
    });

    test('a new login clears the refusal mark', async () => {
        const credentials = await signedIn();
        await credentials.signOut();
        await credentials.setUserKeyPassword('key-2');
        await credentials.setSessionInfo({ uid: 'uid-2', accessToken: 'a', refreshToken: 'r' });
        expect((await new SessionFileStore(dir).load())?.refreshRejectedAt).toBeUndefined();
    });

    test('forget deletes the file', async () => {
        const credentials = await signedIn();
        expect(await credentials.forget()).toBe(true);
        expect(await new SessionFileStore(dir).load()).toBeNull();
        expect(await credentials.forget()).toBe(false);
    });

    test('rejects a file in an unknown format', async () => {
        await signedIn();
        await writeFile(new SessionFileStore(dir).filePath, '{"version": 9}');
        await expect(new SessionFileStore(dir).load()).rejects.toThrow('not in a known format');
    });
});

describe('state lock', () => {
    test('allows one holder at a time', async () => {
        const release = await acquireStateLock(dir);
        await expect(acquireStateLock(dir)).rejects.toThrow('Another proton-drive-mount process');
        await release();
        const again = await acquireStateLock(dir);
        await again();
    });

    test('takes over a lock left by a dead process', async () => {
        const release = await acquireStateLock(dir);
        await writeFile(path.join(dir, 'lock.pid'), '999999999\n');
        const taken = await acquireStateLock(dir);
        await taken();
        await release();
    });

    test('two takeovers of one stale lock: exactly one wins', async () => {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'lock.pid'), '999999999\n');
        const results = await Promise.allSettled([acquireStateLock(dir), acquireStateLock(dir)]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect((await readdir(dir)).filter((name) => name.startsWith('lock.pid'))).toEqual(['lock.pid']);
        for (const result of results) {
            if (result.status === 'fulfilled') {
                await result.value();
            }
        }
    });
});
