import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServerError } from '@protontech/drive-sdk';

import type { SessionCredentials, SessionInfo } from '../vendor/proton-drive-sdk-account/sessionCredentials.ts';
import { FAKE_ACCOUNT_HOST, FakeAccount, KEY_PASSWORD } from './account.ts';
import { FakeDrive, FakeDriveClient } from './drive.ts';

/**
 * A stand-in for the product's session code: it keeps what the account module gives it, and
 * marks a refusal as the product's `signOut` does. `saved` is what a session file would hold.
 */
class TestCredentials implements SessionCredentials {
    saved?: { userKeyPassword?: string; session?: SessionInfo; refusedAt?: string };
    private keyPassword?: string;
    private info?: SessionInfo;
    private readonly callbacks: Array<() => void> = [];
    readonly log: string[] = [];

    constructor(saved?: TestCredentials['saved']) {
        this.saved = saved;
    }

    get uid() {
        return this.info?.uid;
    }
    get accessToken() {
        return this.info?.accessToken;
    }
    get refreshToken() {
        return this.info?.refreshToken;
    }
    on(_event: 'sessionInfoChanged', callback: () => void) {
        this.callbacks.push(callback);
    }
    isLoggedIn() {
        return !!this.keyPassword && !!this.info;
    }
    isTelemetryEnabled() {
        return false;
    }
    getUserKeyPassword() {
        return this.keyPassword;
    }
    async load() {
        this.log.push('load');
        if (!this.saved || this.saved.refusedAt) return;
        this.keyPassword = this.saved.userKeyPassword;
        this.info = this.saved.session;
    }
    async setUserKeyPassword(userKeyPassword: string) {
        this.log.push('setUserKeyPassword');
        this.keyPassword = userKeyPassword;
        this.saved = { ...this.saved, userKeyPassword };
    }
    async setSessionInfo(info: SessionInfo) {
        this.log.push(`setSessionInfo ${info.refreshToken}`);
        this.info = info;
        this.saved = { ...this.saved, session: info, refusedAt: undefined };
        for (const callback of this.callbacks) callback();
    }
    async setTelemetryEnabled(enabled: boolean) {
        this.log.push(`setTelemetryEnabled ${enabled}`);
    }
    async signOut() {
        this.log.push('signOut');
        this.keyPassword = undefined;
        this.info = undefined;
        this.saved = { ...this.saved, refusedAt: 'now' };
    }
}

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-account-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

async function signIn(account: FakeAccount, credentials = new TestCredentials()) {
    const { auth, apiClient } = await account.initAccount({ authClientId: 'external-drive', credentials });
    const urls: string[] = [];
    const done = auth.authViaWeb((url) => void urls.push(url));
    while (urls.length === 0) await Bun.sleep(1);
    expect(account.approve()).toBe(1);
    return { auth, apiClient, credentials, urls, session: await done };
}

describe('the session-fork sign-in', () => {
    test('prints a sign-in URL and waits until it is approved', async () => {
        const account = FakeAccount.open(dir);
        const credentials = new TestCredentials();
        const { auth } = await account.initAccount({ authClientId: 'external-drive', credentials });
        expect(auth.isLoggedIn()).toBe(false);

        const urls: string[] = [];
        let finished = false;
        const done = auth.authViaWeb((url) => void urls.push(url)).then((session) => {
            finished = true;
            return session;
        });
        while (urls.length === 0) await Bun.sleep(1);
        const url = new URL(urls[0]!);
        expect(url.host).toBe(FAKE_ACCOUNT_HOST);
        expect(url.pathname).toBe('/desktop/login');
        expect(decodeURIComponent(url.hash)).toMatch(/^#payload=0:[^:]+:[^:]+:external-drive$/);
        await Bun.sleep(20);
        expect(finished).toBe(false);
        expect(account.report().signIns).toEqual({ started: 1, approved: 0, pending: 1 });

        expect(account.approve()).toBe(1);
        const session = await done;
        expect(session).toEqual({ uid: expect.any(String), accessToken: expect.any(String), refreshToken: 'refresh-1' });
        expect(credentials.log).toEqual(['load', 'setUserKeyPassword', 'setSessionInfo refresh-1', 'setTelemetryEnabled false']);
        expect(credentials.getUserKeyPassword()).toBe(KEY_PASSWORD);
        expect(auth.isLoggedIn()).toBe(true);
        expect(account.report().signIns).toEqual({ started: 1, approved: 1, pending: 0 });
    });

    test('an approval with no sign-in waiting approves nothing', () => {
        expect(FakeAccount.open(dir).approve()).toBe(0);
    });

    test('a sign-in stops when its signal aborts', async () => {
        const account = FakeAccount.open(dir);
        const { auth } = await account.initAccount({ authClientId: 'external-drive', credentials: new TestCredentials() });
        const abort = new AbortController();
        const done = auth.authViaWeb(() => abort.abort(new Error('stopped')), abort.signal);
        await expect(done).rejects.toThrow('stopped');
        expect(account.approve()).toBe(0);
    });

    test('a sign-in with a signal that already aborted rejects at once, and gives no URL', async () => {
        const account = FakeAccount.open(dir);
        const { auth } = await account.initAccount({ authClientId: 'external-drive', credentials: new TestCredentials() });
        const urls: string[] = [];
        let outcome: unknown;
        auth.authViaWeb((url) => void urls.push(url), AbortSignal.abort()).then(
            () => (outcome = 'signed in'),
            (error: unknown) => (outcome = error),
        );
        await Bun.sleep(5);
        expect(outcome).toMatchObject({ name: 'AbortError' });
        expect(urls).toEqual([]);
        expect(account.report().signIns).toEqual({ started: 0, approved: 0, pending: 0 });
    });

    test('a sign-in whose URL cannot go out ends: it no longer waits, and a later abort is harmless', async () => {
        const unhandled: unknown[] = [];
        const record = (reason: unknown) => void unhandled.push(reason);
        process.on('unhandledRejection', record);
        try {
            const account = FakeAccount.open(dir);
            const { auth } = await account.initAccount({ authClientId: 'external-drive', credentials: new TestCredentials() });
            const abort = new AbortController();
            const failed = auth.authViaWeb(() => {
                throw new Error('stdout closed');
            }, abort.signal);
            await expect(failed).rejects.toThrow('stdout closed');
            expect(account.report().signIns).toMatchObject({ started: 1, pending: 0 });
            abort.abort();
            await Bun.sleep(5);
            expect(unhandled).toEqual([]);

            const urls: string[] = [];
            const done = auth.authViaWeb((url) => void urls.push(url));
            while (urls.length === 0) await Bun.sleep(1);
            expect(account.report().signIns).toMatchObject({ started: 2, pending: 1 });
            expect(account.approve()).toBe(1);
            await done;
        } finally {
            process.off('unhandledRejection', record);
        }
    });

    test('the account keeps its state in DIR, and nowhere else', async () => {
        const account = FakeAccount.open(dir);
        await signIn(account);
        const state = JSON.parse(readFileSync(join(dir, 'account.json'), 'utf8'));
        expect(state).toMatchObject({ format: 1, signIns: { started: 1, approved: 1 } });
    });

    test('logout signs the product out, as the account module does', async () => {
        const { auth, credentials } = await signIn(FakeAccount.open(dir));
        await auth.logout();
        expect(credentials.log.at(-1)).toBe('signOut');
        expect(auth.isLoggedIn()).toBe(false);
    });
});

describe('the token refresh', () => {
    test('rotates the refresh token on each refresh, and records which token each refresh used', async () => {
        const account = FakeAccount.open(dir);
        const { apiClient, credentials } = await signIn(account);
        const first = credentials.accessToken;

        expect(await apiClient.refreshSessionIfPossible(first)).toBe(true);
        expect(credentials.refreshToken).toBe('refresh-2');
        expect(credentials.accessToken).not.toBe(first);
        expect(await apiClient.refreshSessionIfPossible(credentials.accessToken)).toBe(true);
        expect(credentials.refreshToken).toBe('refresh-3');
        expect(account.report().refreshes).toEqual([
            { used: 'refresh-1', outcome: 'rotated' },
            { used: 'refresh-2', outcome: 'rotated' },
        ]);
    });

    test('as the account module, it refreshes once for many calls that saw one old token', async () => {
        const account = FakeAccount.open(dir);
        const { apiClient, credentials } = await signIn(account);
        const old = credentials.accessToken;
        expect(await Promise.all([apiClient.refreshSessionIfPossible(old), apiClient.refreshSessionIfPossible(old)])).toEqual([true, true]);
        expect(await apiClient.refreshSessionIfPossible(old)).toBe(true);
        expect(account.report().refreshes).toHaveLength(1);
    });

    test('concurrent Drive calls after an expire share one refresh, and all reach the Drive', async () => {
        const account = FakeAccount.open(dir);
        const client = new FakeDriveClient(FakeDrive.open(dir), { account });
        // As the product's session file: the save of a rotated session takes time.
        const credentials = new (class extends TestCredentials {
            override async setSessionInfo(info: SessionInfo) {
                await Bun.sleep(5);
                await super.setSessionInfo(info);
            }
        })();
        await signIn(account, credentials);
        account.expireAccessToken();
        await Promise.all([client.getMyFilesRootFolder(), client.getMyFilesRootFolder(), client.getMyFilesRootFolder()]);
        expect(account.report().refreshes).toEqual([{ used: 'refresh-1', outcome: 'rotated' }]);
        expect(credentials.refreshToken).toBe('refresh-2');
    });

    test('refuses a refresh token that was already used, as Proton does', async () => {
        const account = FakeAccount.open(dir);
        const { session } = await signIn(account);
        const stale = new TestCredentials({ userKeyPassword: KEY_PASSWORD, session });
        const fresh = new TestCredentials({ userKeyPassword: KEY_PASSWORD, session });
        const a = await account.initAccount({ authClientId: 'external-drive', credentials: fresh });
        expect(await a.apiClient.refreshSessionIfPossible(session.accessToken)).toBe(true);

        const b = await FakeAccount.open(dir).initAccount({ authClientId: 'external-drive', credentials: stale });
        expect(await b.apiClient.refreshSessionIfPossible(session.accessToken)).toBe(false);
        expect(stale.log.at(-1)).toBe('signOut');
        expect(account.report().refreshes).toEqual([
            { used: 'refresh-1', outcome: 'rotated' },
            { used: 'refresh-1', outcome: 'refused' },
        ]);
    });

    test('refuses the next refresh when told to, and the product marks the refusal', async () => {
        const account = FakeAccount.open(dir);
        const { apiClient, credentials } = await signIn(account);
        account.refuseNextRefresh();
        expect(account.report().refuseNextRefresh).toBe(true);

        expect(await apiClient.refreshSessionIfPossible(credentials.accessToken)).toBe(false);
        expect(credentials.log.at(-1)).toBe('signOut');
        expect(credentials.saved?.refusedAt).toBe('now');
        expect(account.report()).toMatchObject({ refuseNextRefresh: false, refreshes: [{ used: 'refresh-1', outcome: 'refused' }] });

        expect(await apiClient.refreshSessionIfPossible(undefined)).toBe(false);
        expect(account.report().refreshes).toHaveLength(1);
    });
});

describe('the Drive checks the access token first', () => {
    async function setUp() {
        const account = FakeAccount.open(dir);
        const drive = FakeDrive.open(dir);
        const client = new FakeDriveClient(drive, { account });
        const signedIn = await signIn(account);
        return { account, drive, client, ...signedIn };
    }

    test('a good access token reaches the Drive with no refresh', async () => {
        const { account, client } = await setUp();
        await client.getMyFilesRootFolder();
        await client.getMyFilesRootFolder();
        expect(account.report().refreshes).toEqual([]);
    });

    test('after the access token expires, the next call refreshes it once, then reaches the Drive', async () => {
        const { account, client, credentials } = await setUp();
        expect(account.expireAccessToken()).toBe(1);
        await client.getMyFilesRootFolder();
        await client.getMyFilesRootFolder();
        expect(account.report().refreshes).toEqual([{ used: 'refresh-1', outcome: 'rotated' }]);
        expect(credentials.refreshToken).toBe('refresh-2');
        expect(client.calls().methods).toEqual({ getMyFilesRootFolder: 2 });
    });

    test('after a refused refresh, every call fails as unauthorized, with no further refresh', async () => {
        const { account, client } = await setUp();
        account.refuseNextRefresh();
        account.expireAccessToken();
        for (let i = 0; i < 2; i++) {
            const error = await client.getMyFilesRootFolder().catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ServerError);
            expect(error).toMatchObject({ statusCode: 401 });
        }
        expect(account.report().refreshes).toEqual([{ used: 'refresh-1', outcome: 'refused' }]);
    });

    test('a generator call checks the token when the product starts to iterate it', async () => {
        const { account, client, drive } = await setUp();
        account.expireAccessToken();
        const listing = client.iterateFolderChildrenNodeUids(drive.rootUid);
        expect(account.report().refreshes).toEqual([]);
        await listing.next();
        expect(account.report().refreshes).toHaveLength(1);
    });

    test('the access token of an earlier generation is not accepted', async () => {
        const account = FakeAccount.open(dir);
        const client = new FakeDriveClient(FakeDrive.open(dir), { account });
        const { session } = await signIn(account);
        expect(session.accessToken).toBe('access-1-1');
        const fresh = new TestCredentials({ userKeyPassword: KEY_PASSWORD, session });
        const { apiClient } = await account.initAccount({ authClientId: 'external-drive', credentials: fresh });
        expect(await apiClient.refreshSessionIfPossible(session.accessToken)).toBe(true);
        expect(fresh.accessToken).toBe('access-1-2');

        const stale = new TestCredentials({ userKeyPassword: KEY_PASSWORD, session });
        await account.initAccount({ authClientId: 'external-drive', credentials: stale });
        await expect(client.getMyFilesRootFolder()).rejects.toMatchObject({ statusCode: 401 });
        expect(account.report().refreshes.at(-1)).toEqual({ used: 'refresh-1', outcome: 'refused' });
    });

    test('an expire reports how many sessions it expired', async () => {
        const account = FakeAccount.open(dir);
        expect(account.expireAccessToken()).toBe(0);
        await signIn(account);
        await signIn(account);
        expect(account.expireAccessToken()).toBe(2);
    });

    test('a Drive with no account bound to a product session checks nothing, as before', async () => {
        const account = FakeAccount.open(dir);
        const client = new FakeDriveClient(FakeDrive.open(dir), { account });
        account.expireAccessToken();
        await client.getMyFilesRootFolder();
        expect(account.report().refreshes).toEqual([]);
    });
});

describe('a saved session', () => {
    test('is accepted by a later process on the same DIR, and its refresh rotates on from there', async () => {
        const first = await signIn(FakeAccount.open(dir));
        const saved = first.credentials.saved;

        const account = FakeAccount.open(dir);
        const credentials = new TestCredentials(saved);
        const client = new FakeDriveClient(FakeDrive.open(dir), { account });
        const { auth } = await account.initAccount({ authClientId: 'external-drive', credentials });
        expect(auth.isLoggedIn()).toBe(true);
        await client.getMyFilesRootFolder();
        expect(account.report().refreshes).toEqual([]);

        account.expireAccessToken();
        await client.getMyFilesRootFolder();
        const third = new TestCredentials(credentials.saved);
        const again = FakeAccount.open(dir);
        await again.initAccount({ authClientId: 'external-drive', credentials: third });
        again.expireAccessToken();
        await new FakeDriveClient(FakeDrive.open(dir), { account: again }).getMyFilesRootFolder();

        expect(again.report()).toMatchObject({
            signIns: { started: 1, approved: 1, pending: 0 },
            refreshes: [
                { used: 'refresh-1', outcome: 'rotated' },
                { used: 'refresh-2', outcome: 'rotated' },
            ],
        });
    });

    test('a session the account never issued is not accepted', async () => {
        const account = FakeAccount.open(dir);
        const credentials = new TestCredentials({ userKeyPassword: KEY_PASSWORD, session: { uid: 'nope', accessToken: 'nope', refreshToken: 'nope' } });
        const client = new FakeDriveClient(FakeDrive.open(dir), { account });
        await account.initAccount({ authClientId: 'external-drive', credentials });
        await expect(client.getMyFilesRootFolder()).rejects.toMatchObject({ statusCode: 401 });
        expect(credentials.log.at(-1)).toBe('signOut');
    });
});
