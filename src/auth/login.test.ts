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
