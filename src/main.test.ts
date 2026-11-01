import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod as chmodAsync, rm as rmAsync } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';

import { VERSION as SDK_VERSION } from '@protontech/drive-sdk';

import { VERSION } from './version.ts';

import { HELP, THIRD_PARTY_NOTICE, run, runCommand, versionAnswer, authStatus } from './main.ts';
import { SessionFileStore } from './session/store.ts';

const REV = 'b'.repeat(40);
const ENV = { PDM_BUILD_REVISION: REV };

const CONSOLE_OUTPUT_QUIET = { print: () => {}, error: () => {} };

/** Signs in through `runCommand` itself, approving through the control channel like a browser would. */
async function signInThroughMain(stateDir: string, driveDir: string, stderrLines: string[]): Promise<void> {
    const printed: string[] = [];
    const login = runCommand(['auth', 'login', '--state-dir', stateDir, '--fake-drive', driveDir], {}, {
        print: (line) => printed.push(line),
        error: (line) => printed.push(line),
    });
    while (![...printed, ...stderrLines].some((line) => /^https:\/\/\S+$/.test(line.trim()))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const controlLine = stderrLines.find((line) => line.startsWith('fake-drive: control channel at '));
    await fetch(new URL('account/approve', controlLine!.replace('fake-drive: control channel at ', '').trim()), { method: 'POST' });
    expect((await login).code).toBe(0);
}

async function waitFor(lines: string[], part: string): Promise<string | undefined> {
    for (let i = 0; i < 500; i++) {
        const line = lines.find((l) => l.includes(part));
        if (line !== undefined) {
            return line;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
}

describe('--version', () => {
    test('names the revision the binary was built from', () => {
        const answer = run(['--version'], ENV);
        expect(answer.code).toBe(0);
        expect(answer.stderr).toBe('');
        expect(answer.stdout).toMatch(new RegExp(`\\b${REV}\\b`));
    });

    test('names the client Proton sees and the Drive SDK it uses', () => {
        const answer = run(['--version'], ENV);
        expect(answer.stdout).toContain('external-drive-protondrivemount@0.1.0-alpha');
        expect(answer.stdout).toContain(`js@${SDK_VERSION}`);
        expect(answer.stdout).toContain(`x-pm-appversion`);
    });

    test('the version answer matches the app-version the binary sends', () => {
        expect(versionAnswer(ENV)).toContain('(x-pm-appversion ');
    });
});

describe('--help', () => {
    test('says the binary is a third-party client', () => {
        for (const argv of [['--help'], ['-h'], ['help']]) {
            const answer = run(argv, ENV);
            expect(answer.code).toBe(0);
            expect(answer.stdout).toContain(THIRD_PARTY_NOTICE);
        }
    });

    test('HELP prints the usage for the current version', () => {
        expect(HELP).toContain(`proton-drive-mount ${VERSION}`);
        expect(HELP).toContain('Usage:');
    });
});

describe('bare and unknown invocations', () => {
    test('a bare invocation shows the usage and exits 2', () => {
        const answer = run([], ENV);
        expect(answer.code).toBe(2);
        expect(answer.stderr).toContain(THIRD_PARTY_NOTICE);
    });

    test('an unknown command shows the usage and exits 2', () => {
        const answer = run(['frobnicate'], ENV);
        expect(answer.code).toBe(2);
        expect(answer.stderr).toContain('Unknown command "frobnicate"');
        expect(answer.stderr).toContain(THIRD_PARTY_NOTICE);
    });
});

describe('serve dispatch', () => {
    test('HELP names the serve command and its flags', () => {
        expect(HELP).toContain('serve [--host 127.0.0.1] [--port 7395]');
        expect(HELP).toContain('--host HOST');
        expect(HELP).toContain('--port PORT');
        expect(HELP).toContain('--root PATH');
    });

    test('a bad --port exits 2 without starting anything', async () => {
        const answer = await runCommand(['serve', '--port', 'not-a-port', '--state-dir', mkdtempSync(join(tmpdir(), 'pdm-main-port-XXXXXX'))], {});
        expect(answer.code).toBe(2);
        expect(answer.stderr).toContain('Bad --port not-a-port');
    });

    test('the serve runs against the fake drive and stops on the signal', async () => {
        const stateDir = mkdtempSync(join(tmpdir(), 'pdm-main-serve-state-XXXXXX'));
        const driveDir = mkdtempSync(join(tmpdir(), 'pdm-main-serve-drive-XXXXXX'));
        const stderrLines: string[] = [];
        const realWrite = process.stderr.write;
        process.stderr.write = ((chunk: string | Uint8Array) => {
            stderrLines.push(String(chunk));
            return realWrite.call(process.stderr, chunk);
        }) as typeof process.stderr.write;
        try {
            await signInThroughMain(stateDir, driveDir, stderrLines);
            const abort = new AbortController();
            const serve = runCommand(['serve', '--state-dir', stateDir, '--fake-drive', driveDir, '--port', '0'], {}, CONSOLE_OUTPUT_QUIET, abort.signal);
            const servingLine = await waitFor(stderrLines, 'Serving Proton Drive');
            expect(servingLine).toBeString();
            const url = servingLine!.match(/https?:\/\/\S+/)![0];
            const options = await fetch(url, { method: 'OPTIONS' });
            expect(options.status).toBe(200);
            expect(options.headers.get('DAV')).toBe('1');
            abort.abort();
            expect((await serve).code).toBe(0);
        } finally {
            process.stderr.write = realWrite;
            for (const dir of [stateDir, driveDir]) {
                await chmodAsync(dir, 0o700).catch(() => {});
                await rmAsync(dir, { recursive: true, force: true });
            }
        }
    });
});

describe('auth login dispatch', () => {
    test('runCommand streams a sign-in against the fake drive and exits 0', async () => {
        const mkdtemp = (label: string) => mkdtempSync(join(tmpdir(), `pdm-main-${label}-XXXXXX`));
        const stateDir = mkdtemp('state');
        const driveDir = mkdtemp('drive');
        const printed: string[] = [];
        const output = { print: (line: string) => printed.push(line), error: (line: string) => printed.push(line) };
        // The Receive arm prints the control channel on stderr; watch it there.
        const stderrLines: string[] = [];
        const realWrite = process.stderr.write;
        process.stderr.write = ((chunk: string | Uint8Array) => {
            stderrLines.push(String(chunk));
            return realWrite.call(process.stderr, chunk);
        }) as typeof process.stderr.write;
        try {
            const login = runCommand(['auth', 'login', '--state-dir', stateDir, '--fake-drive', driveDir], {}, output);
            // Approve once the sign-in URL is out, as the user approves it in a browser.
            while (![...printed, ...stderrLines].some((line) => /^https:\/\/\S+$/.test(line.trim()))) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const controlLine = stderrLines.find((line) => line.startsWith('fake-drive: control channel at '));
            expect(controlLine).toBeString();
            await fetch(new URL('account/approve', controlLine!.replace('fake-drive: control channel at ', '').trim()), {
                method: 'POST',
            });
            const answer = await login;
            expect(answer.code).toBe(0);
            expect(printed.some((line) => line.includes('Signed in.'))).toBeTrue();
        } finally {
            process.stderr.write = realWrite;
            for (const dir of [stateDir, driveDir]) {
                await chmodAsync(dir, 0o700).catch(() => {});
                await rmAsync(dir, { recursive: true, force: true });
            }
        }
    });

    test('an unknown command still shows the usage and exits 2', async () => {
        const answer = await runCommand(['nope'], {});
        expect(answer.code).toBe(2);
        expect(answer.stderr).toContain('Unknown command "nope"');
    });
});

describe('auth status', () => {
    const mkdtemp = (label: string) => mkdtempSync(join(tmpdir(), `pdm-main-status-${label}-XXXXXX`));

    function storedSession(refreshRejectedAt?: string) {
        return {
            version: 1 as const,
            appVersion: 'external-drive-protondrivemount@0.1.0-alpha',
            savedAt: '2026-10-31T12:00:00.000Z',
            userKeyPassword: 'key-password',
            refreshRejectedAt,
            session: { uid: 'abcdefgh-1234-5678-90ab-cdefghijklmn', accessToken: 'access-1-1', refreshToken: 'refresh-1' },
        };
    }

    test('without a session it says not signed in and exits 1', async () => {
        const stateDir = mkdtemp('empty');
        const printed: string[] = [];
        const code = await authStatus(stateDir, { print: (line) => printed.push(line), error: () => {} });
        expect(code).toBe(1);
        expect(printed.some((line) => line.includes('Not signed in'))).toBeTrue();
    });

    test('with a healthy session it reports it locally and exits 0', async () => {
        const stateDir = mkdtemp('ok');
        await new SessionFileStore(stateDir).save(storedSession());
        const printed: string[] = [];
        const code = await authStatus(stateDir, { print: (line) => printed.push(line), error: () => {} });
        expect(code).toBe(0);
        const text = printed.join('\n');
        expect(text).toContain('Session UID:     abcdefgh…');
        expect(text).toContain('Saved at:        2026-10-31T12:00:00.000Z');
        expect(text).toContain('Refresh token:   present');
        expect(text).toContain('signed in');
        expect(text).toContain('makes no Proton call');
    });

    test('a session Proton refused is named, and exits 1', async () => {
        const stateDir = mkdtemp('refused');
        await new SessionFileStore(stateDir).save(storedSession('2026-10-31T13:00:00.000Z'));
        const printed: string[] = [];
        const code = await authStatus(stateDir, { print: (line) => printed.push(line), error: () => {} });
        expect(code).toBe(1);
        const text = printed.join('\n');
        expect(text).toContain('Proton refused the session at 2026-10-31T13:00:00.000Z');
        expect(text).toContain('Run "auth login" again');
    });

    test('runCommand dispatches auth status with the state dir', async () => {
        const stateDir = mkdtemp('dispatch');
        await new SessionFileStore(stateDir).save(storedSession());
        const printed: string[] = [];
        const answer = await runCommand(['auth', 'status', '--state-dir', stateDir], {}, {
            print: (line) => printed.push(line),
            error: (line) => printed.push(line),
        });
        expect(answer.code).toBe(0);
        expect(printed.join('\n')).toContain('signed in');
    });
});
