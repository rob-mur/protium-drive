import { chmod, rm, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { FileCredentials } from './credentials.ts';
import { SessionFileStore } from './store.ts';

const DIRS: string[] = [];

afterEach(async () => {
    for (const dir of DIRS.splice(0)) {
        await chmod(dir, 0o700).catch(() => {});
        await rm(dir, { recursive: true, force: true });
    }
});

function newCredentials(): { credentials: FileCredentials; store: SessionFileStore } {
    const dir = mkdtempSync(join(tmpdir(), 'pdm-cred-XXXXXX'));
    DIRS.push(dir);
    const store = new SessionFileStore(dir);
    return { credentials: new FileCredentials(store, 'external-drive-protondrivemount@0.1.0-alpha'), store };
}

describe('FileCredentials', () => {
    test('a fresh credentials loads nothing and is not signed in', async () => {
        const { credentials } = newCredentials();
        await credentials.load();
        expect(credentials.isLoggedIn()).toBeFalse();
        expect(credentials.uid).toBeUndefined();
    });

    test('the key password and the session persist as they are set, as the account module sets them', async () => {
        const { credentials, store } = newCredentials();
        // Nothing persists half-set: the key password alone is not a session.
        await credentials.setUserKeyPassword('key-password');
        expect(await store.load()).toBeNull();

        await credentials.setSessionInfo({ uid: 'session-1', accessToken: 'access-1-1', refreshToken: 'refresh-1' });

        const stored = await store.load();
        expect(stored).toMatchObject({ userKeyPassword: 'key-password', session: { uid: 'session-1', refreshToken: 'refresh-1' } });
        expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
        expect(credentials.isLoggedIn()).toBeTrue();
    });

    test('a new instance loads the saved session', async () => {
        const first = newCredentials();
        await first.credentials.setUserKeyPassword('key-password');
        await first.credentials.setSessionInfo({ uid: 'session-1', accessToken: 'access-1-1', refreshToken: 'refresh-1' });

        const second = new FileCredentials(first.store, 'external-drive-protondrivemount@0.1.0-alpha');
        await second.load();

        expect(second.isLoggedIn()).toBeTrue();
        expect(second.refreshToken).toBe('refresh-1');
    });

    test('signOut clears the session in memory but keeps the file with a refusal mark', async () => {
        const { credentials, store } = newCredentials();
        await credentials.setUserKeyPassword('key-password');
        await credentials.setSessionInfo({ uid: 'session-1', accessToken: 'access-1-1' });

        await credentials.signOut();

        expect(credentials.isLoggedIn()).toBeFalse();
        const stored = await store.load();
        expect(stored?.userKeyPassword).toBe('key-password');
        expect(stored?.refreshRejectedAt).toBeString();
        // A reload of a refused session uses none of it.
        const fresh = new FileCredentials(store, 'x');
        await fresh.load();
        expect(fresh.isLoggedIn()).toBeFalse();
        expect(fresh.rejectedAt).toBeString();
    });

    test('forget deletes the file', async () => {
        const { credentials, store } = newCredentials();
        await credentials.setUserKeyPassword('key-password');
        await credentials.setSessionInfo({ uid: 'session-1', accessToken: 'access-1-1' });
        expect(await credentials.forget()).toBeTrue();
        expect(await store.load()).toBeNull();
    });

    test('isTelemetryEnabled is always false: this client sends Proton no telemetry', () => {
        expect(newCredentials().credentials.isTelemetryEnabled()).toBeFalse();
    });

    test('sessionInfoChanged callbacks fire when the session changes', async () => {
        const { credentials } = newCredentials();
        let changes = 0;
        credentials.on('sessionInfoChanged', () => changes++);
        await credentials.setSessionInfo({ uid: 'session-1', accessToken: 'access-1-1' });
        expect(changes).toBe(1);
    });
});
