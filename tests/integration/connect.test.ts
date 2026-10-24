import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { silentLogger } from '../../src/logger';
import { accountUrlFromBaseUrl, connectProton } from '../../src/proton/connect';
import { FileCredentials } from '../../src/session/credentials';
import { SessionFileStore } from '../../src/session/store';
import { APP_VERSION } from '../../src/version';

/**
 * Exercises the vendored account module and our session file against a local
 * mock of the Proton API. Nothing here reaches Proton.
 */
type Seen = { method: string; path: string; appVersion: string | null; authorization: string | null };

let dir: string;
let seen: Seen[];
let refreshStatus: number;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pdm-connect-'));
    seen = [];
    refreshStatus = 200;
    server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            seen.push({
                method: request.method,
                path: url.pathname,
                appVersion: request.headers.get('x-pm-appversion'),
                authorization: request.headers.get('Authorization'),
            });
            if (url.pathname === '/auth/v4/refresh') {
                const body = (await request.json()) as { RefreshToken?: string };
                if (refreshStatus !== 200 || body.RefreshToken !== 'refresh-1') {
                    return Response.json({ Code: 10013, Error: 'Invalid refresh token' }, { status: refreshStatus === 200 ? 422 : refreshStatus });
                }
                return Response.json({ Code: 1000, UID: 'uid-1', AccessToken: 'access-2', RefreshToken: 'refresh-2' });
            }
            if (url.pathname === '/test/ping') {
                if (request.headers.get('Authorization') === 'Bearer access-2') {
                    return Response.json({ Code: 1000 });
                }
                return Response.json({ Code: 401, Error: 'Expired' }, { status: 401 });
            }
            return Response.json({ Code: 404 }, { status: 404 });
        },
    });
    baseUrl = server.url.href.replace(/\/$/, '');

    const credentials = new FileCredentials(new SessionFileStore(dir), APP_VERSION);
    await credentials.setUserKeyPassword('key-password');
    await credentials.setSessionInfo({ uid: 'uid-1', accessToken: 'access-1', refreshToken: 'refresh-1' });
});

afterEach(async () => {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
});

async function connectAndPing() {
    const connection = await connectProton({ stateDir: dir, logger: silentLogger(), baseUrl });
    await connection.credentials.load();
    const response = await connection.apiClient.authenticatedRequest.get(`${baseUrl}/test/ping`, { throwHttpErrors: false, retry: 0 });
    return { connection, response };
}

describe('session refresh after a restart', () => {
    test('an expired access token is refreshed with the stored refresh token, without a password login', async () => {
        const { connection, response } = await connectAndPing();
        expect(response.status).toBe(200);
        expect(connection.credentials.isLoggedIn()).toBe(true);
        expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /test/ping', 'POST /auth/v4/refresh', 'GET /test/ping']);

        const stored = await new SessionFileStore(dir).load();
        expect(stored?.session).toEqual({ uid: 'uid-1', accessToken: 'access-2', refreshToken: 'refresh-2' });
    });

    test('every request carries the honest x-pm-appversion', async () => {
        await connectAndPing();
        expect(seen.length).toBeGreaterThan(0);
        for (const request of seen) {
            expect(request.appVersion).toBe(APP_VERSION);
        }
    });

    test('a refused refresh token marks the session but keeps the file', async () => {
        refreshStatus = 400;
        const { connection, response } = await connectAndPing();
        expect(response.status).toBe(401);
        expect(connection.credentials.isLoggedIn()).toBe(false);
        const stored = await new SessionFileStore(dir).load();
        expect(stored?.refreshRejectedAt).toBeString();
        expect(stored?.session.refreshToken).toBe('refresh-1');
    });

    test('a 429 on refresh does not sign out', async () => {
        refreshStatus = 429;
        const { connection } = await connectAndPing();
        expect(connection.credentials.isLoggedIn()).toBe(true);
        expect((await new SessionFileStore(dir).load())?.refreshRejectedAt).toBeUndefined();
    });
});

test('builds a real ProtonDriveClient without any network call', async () => {
    const connection = await connectProton({ stateDir: dir, logger: silentLogger(), baseUrl });
    const client = await connection.createDriveClient();
    expect(typeof client.getMyFilesRootFolder).toBe('function');
    expect(typeof client.getEventScheduler).toBe('function');
    expect((await Bun.file(path.join(dir, 'client-uid')).text()).trim()).toStartWith('protondrivemount-');
    expect(seen).toEqual([]);
});

test('accountUrlFromBaseUrl follows the API host', () => {
    expect(accountUrlFromBaseUrl('drive-api.proton.me')).toBe('account.proton.me');
    expect(accountUrlFromBaseUrl('https://drive-api.proton.black')).toBe('account.proton.black');
    expect(accountUrlFromBaseUrl('http://127.0.0.1:1234')).toBe('account.proton.me');
});
