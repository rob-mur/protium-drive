import { chmod, rm, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { authLogin, REPLACE_WARNING } from './login.ts';
import { acquireStateLock } from '../session/lock.ts';
import { SessionFileStore } from '../session/store.ts';
import { APP_VERSION } from '../version.ts';
import { THIRD_PARTY_NOTICE } from '../notice.ts';

const DIRS: string[] = [];
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Runs one sign-in against the fake drive and approves it through the Receive
 * arm's control channel once the sign-in URL is out, as the user approves it
 * in a browser.
 */
async function signIn(stateDir: string, driveDir: string, lines: string[]): Promise<number> {
    let controlUrl: URL | undefined;
    let urlIsOut: (() => void) | undefined;
    const urlSeen = new Promise<void>((resolve) => {
        urlIsOut = resolve;
    });
    const done = authLogin({
        stateDir,
        logger: QUIET,
        fakeDriveDir: driveDir,
        print: (line) => {
            lines.push(line);
            if (/^https:\/\/\S+$/.test(line.trim())) urlIsOut?.();
        },
        onControlUrl: (url) => {
            controlUrl = url;
        },
    });
    await urlSeen;
    await fetch(new URL('account/approve', controlUrl), { method: 'POST' });
    return done;
}

function scratch(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `pdm-login-${label}-XXXXXX`));
    DIRS.push(dir);
    return dir;
}

function indexOfLine(lines: string[], part: string): number {
    return lines.findIndex((line) => line.includes(part));
}

describe('authLogin', () => {
    test('prints the notice, the client and a sign-in URL, and saves a 0600 session in a 0700 directory', async () => {
        const stateDir = scratch('state');
        const lines: string[] = [];

        const code = await signIn(stateDir, scratch('drive'), lines);

        expect(code).toBe(0);
        const notice = indexOfLine(lines, THIRD_PARTY_NOTICE);
        const client = indexOfLine(lines, `Client: ${APP_VERSION}`);
        const url = lines.findIndex((line) => /^https:\/\/\S+$/.test(line.trim()));
        expect(notice).toBeGreaterThanOrEqual(0);
        expect(client).toBeGreaterThan(notice);
        expect(url).toBeGreaterThan(client);
        expect(lines.at(-1)).toBe(`Signed in. Session saved to ${stateDir}/session.json (mode 0600).`);

        expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
        expect((await stat(`${stateDir}/session.json`)).mode & 0o777).toBe(0o600);
        const stored = await new SessionFileStore(stateDir).load();
        expect(stored?.userKeyPassword).toBe('fake-drive-key-password');
        expect(stored?.session.refreshToken).toBe('refresh-1');
    });

    test('the sign-in URL it prints is the fake account\'s, so nothing reaches Proton', async () => {
        const lines: string[] = [];
        await signIn(scratch('state'), scratch('drive'), lines);
        const url = lines.find((line) => /^https:\/\/\S+$/.test(line.trim())) ?? '';
        expect(url).toContain('account.fake-drive.invalid');
    });

    test('signing in again warns before the URL and replaces the session whole', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        const first: string[] = [];
        await signIn(stateDir, driveDir, first);
        const firstUid = (await new SessionFileStore(stateDir).load())?.session.uid;

        const second: string[] = [];
        const code = await signIn(stateDir, driveDir, second);

        expect(code).toBe(0);
        const warned = indexOfLine(second, REPLACE_WARNING);
        const url = second.findIndex((line) => /^https:\/\/\S+$/.test(line.trim()));
        expect(warned).toBe(0);
        expect(url).toBeGreaterThan(warned);
        expect(second.at(-1)).toContain('Signed in.');

        const stored = await new SessionFileStore(stateDir).load();
        expect(stored?.session.uid).not.toBe(firstUid);
        expect(second.filter((line) => line.includes(REPLACE_WARNING))).toHaveLength(1);
    });

    test('a first sign-in never warns about a session that is not there', async () => {
        const lines: string[] = [];
        await signIn(scratch('state'), scratch('drive'), lines);
        expect(lines.some((line) => line.includes('A session already exists'))).toBeFalse();
    });

    test('refuses while another process holds the state lock, naming its pid, and keeps the session', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        await signIn(stateDir, driveDir, []);
        const before = await new SessionFileStore(stateDir).load();
        const release = await acquireStateLock(stateDir);
        const lines: string[] = [];
        try {
            await expect(authLogin({ stateDir, logger: QUIET, fakeDriveDir: driveDir, print: (l) => lines.push(l) })).rejects.toThrow(`pid ${process.pid}`);
        } finally {
            await release();
        }
        expect(lines).toEqual([]);
        expect(await new SessionFileStore(stateDir).load()).toEqual(before);
    });

    test('holds the state lock until the sign-in ends, so a serve cannot start meanwhile', async () => {
        const stateDir = scratch('state');
        let urlIsOut!: () => void;
        const urlSeen = new Promise<void>((resolve) => (urlIsOut = resolve));
        let controlUrl: URL | undefined;
        const done = authLogin({
            stateDir,
            logger: QUIET,
            fakeDriveDir: scratch('drive'),
            print: (line) => {
                if (/^https:\/\/\S+$/.test(line.trim())) urlIsOut();
            },
            onControlUrl: (url) => (controlUrl = url),
        });
        await urlSeen;
        await expect(acquireStateLock(stateDir)).rejects.toThrow(`pid ${process.pid}`);
        await fetch(new URL('account/approve', controlUrl), { method: 'POST' });
        expect(await done).toBe(0);
        const release = await acquireStateLock(stateDir);
        await release();
    });

    describe('a sign-in link that times out', () => {
        /** One link's wait in the account module: 5 s, then 10 minutes of polls. */
        const LINK_LIFETIME_S = 5 + 10 * 60;
        const isUrl = (line: string) => /^https:\/\/\S+$/.test(line.trim());

        /** Starts `auth login` on the fake drive; `links` resolves once `count` URLs are out. */
        function start(stateDir: string, signal?: AbortSignal) {
            const lines: string[] = [];
            let controlUrl: URL | undefined;
            const waiters: Array<{ count: number; resolve: () => void }> = [];
            const done = authLogin({
                stateDir,
                logger: QUIET,
                fakeDriveDir: scratch('drive'),
                signal,
                print: (line) => {
                    lines.push(line);
                    const urls = lines.filter(isUrl).length;
                    for (const waiter of waiters.filter((each) => each.count <= urls)) waiter.resolve();
                },
                onControlUrl: (url) => (controlUrl = url),
            });
            done.catch(() => {});
            const links = (count: number) =>
                lines.filter(isUrl).length >= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve }));
            const post = (path: string, body?: unknown) =>
                fetch(new URL(path, controlUrl), { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
            // The last timeout ends the sign-in, which may close the control channel before it answers.
            const timeOut = () => post('clock/advance', { seconds: LINK_LIFETIME_S }).catch(() => undefined);
            return { lines, done, links, timeOut, approve: () => post('account/approve') };
        }

        test('is replaced by a new link, and approving the new link signs the user in', async () => {
            const stateDir = scratch('state');
            const login = start(stateDir);
            await login.links(1);
            await login.timeOut();
            await login.links(2);
            await login.approve();

            expect(await login.done).toBe(0);
            const urls = login.lines.filter(isUrl);
            expect(new Set(urls).size).toBe(2);
            const second = login.lines.indexOf(urls[1]!);
            expect(login.lines[second - 1]).toBe('The last link timed out. Open this new URL instead (link 2 of 3):');
            expect(login.lines.at(-1)).toContain('Signed in.');
            expect(await new SessionFileStore(stateDir).load()).not.toBeNull();
        });

        test('the first link says how long a link works and that a new one follows', async () => {
            const login = start(scratch('state'));
            await login.links(1);
            await login.approve();
            expect(await login.done).toBe(0);
            expect(login.lines).toContain(
                'Keep this command running. Each link works for about 10 minutes. When one times out, a new link follows, up to 3 links.',
            );
            expect(login.lines.some((line) => line.includes('waits up to 10 minutes'))).toBeFalse();
        });

        test('three times stops the sign-in with an error that says so, and saves no session', async () => {
            const stateDir = scratch('state');
            const login = start(stateDir);
            for (const link of [1, 2, 3]) {
                await login.links(link);
                await login.timeOut();
            }

            await expect(login.done).rejects.toThrow('No one approved the sign-in: all 3 sign-in links timed out. Run proton-drive-mount auth login again.');
            expect(new Set(login.lines.filter(isUrl)).size).toBe(3);
            expect(await new SessionFileStore(stateDir).load()).toBeNull();
            const release = await acquireStateLock(stateDir);
            await release();
        });

        test('an abort while a later link waits stops the sign-in at once, with no new link', async () => {
            const stateDir = scratch('state');
            const controller = new AbortController();
            const login = start(stateDir, controller.signal);
            await login.links(1);
            await login.timeOut();
            await login.links(2);
            controller.abort();

            await expect(login.done).rejects.toThrow();
            expect(login.lines.filter(isUrl)).toHaveLength(2);
            expect(await new SessionFileStore(stateDir).load()).toBeNull();
        });
    });

    test('an aborted sign-in does not save a session', async () => {
        const stateDir = scratch('state');
        const controller = new AbortController();
        const lines: string[] = [];
        const pending = authLogin({ stateDir, logger: QUIET, fakeDriveDir: scratch('drive'), print: (l) => lines.push(l), signal: controller.signal });
        controller.abort();
        expect(pending).rejects.toThrow();
        expect(await new SessionFileStore(stateDir).load()).toBeNull();
        expect(lines.some((line) => line.includes('Signed in.'))).toBeFalse();
    });
});
