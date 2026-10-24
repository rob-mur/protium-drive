import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { silentLogger } from '../../src/logger';
import { connectProton } from '../../src/proton/connect';
import { SessionFileStore } from '../../src/session/store';
import { APP_VERSION } from '../../src/version';

/**
 * The session-fork login, end to end against a local mock of the Proton API:
 * the mock plays the browser that approves the sign-in and encrypts the key
 * password with the key from the printed URL. Nothing here reaches Proton.
 */
let dir: string;
let server: ReturnType<typeof Bun.serve>;
let forkKey: Buffer | undefined;
let statusPolls = 0;
const appVersions = new Set<string | null>();

function encryptForkPayload(key: Buffer, json: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('fork', 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}

beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pdm-login-'));
    server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            appVersions.add(request.headers.get('x-pm-appversion'));
            if (url.pathname === '/auth/v4/sessions/forks') {
                return Response.json({ Code: 1000, Selector: 'selector-1', UserCode: 'ABCD1234' });
            }
            if (url.pathname === '/auth/v4/sessions/forks/selector-1') {
                statusPolls++;
                if (statusPolls === 1 || !forkKey) {
                    return Response.json({ Code: 9001, Error: 'Not ready' }, { status: 422 });
                }
                return Response.json({
                    Code: 1000,
                    UID: 'uid-new',
                    AccessToken: 'access-new',
                    RefreshToken: 'refresh-new',
                    Payload: encryptForkPayload(forkKey, JSON.stringify({ type: 'default', keyPassword: 'key-password-new' })),
                });
            }
            return Response.json({ Code: 404, Error: 'Not in the mock' }, { status: 404 });
        },
    });
});

afterAll(async () => {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
});

test('auth login: prints a sign-in URL, waits for approval, then saves the session 0600', async () => {
    const baseUrl = server.url.href.replace(/\/$/, '');
    const { auth, credentials } = await connectProton({ stateDir: dir, logger: silentLogger(), baseUrl });

    let signInUrl = '';
    await auth.authViaWeb((url) => {
        signInUrl = url;
        // The "browser": read the key from the URL fragment, as the account page does.
        const payload = decodeURIComponent(new URL(url).hash.replace(/^#payload=/, ''));
        const [, userCode, key, clientId] = payload.split(':');
        expect(userCode).toBe('ABCD1234');
        expect(clientId).toBe('external-drive');
        forkKey = Buffer.from(key, 'base64');
    });

    expect(signInUrl).toStartWith('https://account.proton.me/desktop/login?app=drive&pv=3#payload=');
    expect(statusPolls).toBe(2);
    expect(credentials.isLoggedIn()).toBe(true);
    expect([...appVersions]).toEqual([APP_VERSION]);

    const store = new SessionFileStore(dir);
    const stored = await store.load();
    expect(stored?.session).toEqual({ uid: 'uid-new', accessToken: 'access-new', refreshToken: 'refresh-new' });
    expect(stored?.userKeyPassword).toBe('key-password-new');
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
}, 30_000);
