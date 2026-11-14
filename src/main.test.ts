import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod as chmodAsync, rm as rmAsync } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';

import { VERSION as SDK_VERSION } from '@protontech/drive-sdk';

import { VERSION } from './version.ts';

import { HELP, THIRD_PARTY_NOTICE, run, runCommand, versionAnswer, authStatus, authLogout } from './main.ts';
import { ListingCacheFile } from './drive/listing-cache.ts';
import { SessionFileStore } from './session/store.ts';
import { acquireStateLock } from './session/lock.ts';
import { FakeDrive } from '../fake-drive/drive.ts';
import { TEMPORARY_SUFFIX } from './migrate.ts';

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

describe('log level', () => {
    test('HELP lists --log-level with its levels, and names PDM_LOG_LEVEL under Environment', () => {
        expect(HELP).toContain('--log-level LEVEL');
        expect(HELP).toContain('debug, info, warn or error');
        expect(HELP).toMatch(/\nEnvironment:\n {2}PDM_LOG_LEVEL /);
    });

    test('every command takes --log-level', async () => {
        const stateDir = mkdtempSync(join(tmpdir(), 'pdm-main-log-level-'));
        try {
            const status = await runCommand(['auth', 'status', '--log-level', 'debug', '--state-dir', stateDir], {}, CONSOLE_OUTPUT_QUIET);
            expect(status.code).toBe(1);
            const logout = await runCommand(['auth', 'logout', '--log-level', 'warn', '--state-dir', stateDir], {}, CONSOLE_OUTPUT_QUIET);
            expect(logout.code).toBe(0);
            expect(run(['--log-level', 'debug'], ENV).code).toBe(2);
            expect((await runCommand(['--log-level', 'debug', '--help'], {})).code).toBe(0);
        } finally {
            await rmAsync(stateDir, { recursive: true, force: true });
        }
    });

    test('a level that is not a level exits 2 and names it, from the flag or from PDM_LOG_LEVEL, before any command starts', async () => {
        const stateDir = mkdtempSync(join(tmpdir(), 'pdm-main-bad-level-'));
        try {
            for (const command of [['auth', 'status'], ['auth', 'logout'], ['auth', 'login'], ['serve'], ['mount', '/nonexistent-mountpoint'], ['migrate-node-keys', 'Photos']]) {
                const withFlag = await runCommand([...command, '--log-level', 'loud', '--state-dir', stateDir], {}, CONSOLE_OUTPUT_QUIET);
                expect(withFlag.code).toBe(2);
                expect(withFlag.stderr).toContain('--log-level "loud"');
                const withVariable = await runCommand([...command, '--state-dir', stateDir], { PDM_LOG_LEVEL: 'loud' }, CONSOLE_OUTPUT_QUIET);
                expect(withVariable.code).toBe(2);
                expect(withVariable.stderr).toContain('PDM_LOG_LEVEL "loud"');
            }
        } finally {
            await rmAsync(stateDir, { recursive: true, force: true });
        }
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

describe('mount dispatch', () => {
    test('HELP names the cache flags and their defaults', () => {
        for (const text of ['--dir-cache-time DURATION', '--vfs-cache-max-size SIZE', '--cache-dir DIR', 'Default: 30s', 'Default: 6G']) {
            expect(HELP).toContain(text);
        }
    });

    test('a bad cache setting exits 2, naming the flag, before the serve starts', async () => {
        const driveDir = mkdtempSync(join(tmpdir(), 'pdm-mount-dispatch-'));
        try {
            for (const [flag, value] of [
                ['--dir-cache-time', 'banana'],
                ['--vfs-cache-max-size', 'big'],
                ['--cache-dir', ''],
            ]) {
                // No session and a fake drive that holds nothing: a serve that started would fail on its own.
                const answer = await runCommand(['mount', '/nonexistent-mountpoint', flag!, value!, '--fake-drive', driveDir, '--state-dir', join(driveDir, 'state')], {});
                expect(answer.code).toBe(2);
                expect(answer.stderr).toContain(flag!);
                expect(answer.stderr).toContain('Usage: proton-drive-mount mount MOUNTPOINT');
            }
        } finally {
            await rmAsync(driveDir, { recursive: true, force: true });
        }
    });
});

describe('migrate-node-keys dispatch', () => {
    test('HELP names the command, its folder and --dry-run', () => {
        expect(HELP).toContain('migrate-node-keys FOLDER [--dry-run]');
        expect(HELP).toContain('--dry-run');
    });

    test('without a folder, or with two, it exits 2 and shows the usage', async () => {
        for (const argv of [['migrate-node-keys'], ['migrate-node-keys', 'a', 'b']]) {
            const answer = await runCommand(argv, {});
            expect(answer.code).toBe(2);
            expect(answer.stderr).toContain('Usage: proton-drive-mount migrate-node-keys FOLDER [--dry-run]');
        }
    });

    /** Signs in the way a user does, reading the control channel from stderr, as the serve test does. */
    async function signIn(stateDir: string, driveDir: string): Promise<void> {
        const stderrLines: string[] = [];
        const realWrite = process.stderr.write;
        process.stderr.write = ((chunk: string | Uint8Array) => {
            stderrLines.push(String(chunk));
            return realWrite.call(process.stderr, chunk);
        }) as typeof process.stderr.write;
        try {
            await signInThroughMain(stateDir, driveDir, stderrLines);
        } finally {
            process.stderr.write = realWrite;
        }
    }

    async function withDrives<T>(work: (stateDir: string, driveDir: string, lines: string[]) => Promise<T>): Promise<T> {
        const stateDir = mkdtempSync(join(tmpdir(), 'pdm-main-migrate-state-XXXXXX'));
        const driveDir = mkdtempSync(join(tmpdir(), 'pdm-main-migrate-drive-XXXXXX'));
        try {
            return await work(stateDir, driveDir, []);
        } finally {
            for (const dir of [stateDir, driveDir]) {
                await chmodAsync(dir, 0o700).catch(() => {});
                await rmAsync(dir, { recursive: true, force: true });
            }
        }
    }

    function capture(lines: string[]) {
        return { print: (line: string) => lines.push(line), error: (line: string) => lines.push(`error: ${line}`) };
    }

    test('signed out, it says so and exits 1', async () => {
        await withDrives(async (stateDir, driveDir, lines) => {
            const answer = await runCommand(['migrate-node-keys', 'Photos', '--state-dir', stateDir, '--fake-drive', driveDir], {}, capture(lines));
            expect(answer.code).toBe(1);
            expect(lines).toEqual(['error: Not signed in to Proton. Run "proton-drive-mount auth login" first.']);
        });
    });

    test('a session Proton refused is named, and exits 1', async () => {
        await withDrives(async (stateDir, driveDir, lines) => {
            await signIn(stateDir, driveDir);
            const store = new SessionFileStore(stateDir);
            const stored = (await store.load())!;
            await store.save({ ...stored, refreshRejectedAt: '2026-08-01T00:00:00.000Z' });
            const answer = await runCommand(['migrate-node-keys', 'Photos', '--state-dir', stateDir, '--fake-drive', driveDir], {}, capture(lines));
            expect(answer.code).toBe(1);
            expect(lines[0]).toContain('Proton refused the stored session at 2026-08-01T00:00:00.000Z');
        });
    });

    test('a folder the Drive lacks exits 1 and names it', async () => {
        await withDrives(async (stateDir, driveDir, lines) => {
            await signIn(stateDir, driveDir);
            const answer = await runCommand(['migrate-node-keys', 'Nowhere', '--state-dir', stateDir, '--fake-drive', driveDir], {}, capture(lines));
            expect(answer.code).toBe(1);
            expect(lines).toEqual(['error: /Nowhere not found']);
        });
    });

    test('it migrates the folder, lists each file and sums up; a dry run changes nothing', async () => {
        await withDrives(async (stateDir, driveDir, lines) => {
            await signIn(stateDir, driveDir);
            const drive = FakeDrive.open(driveDir);
            drive.add('Photos/beach.jpg', { type: 'file', content: new TextEncoder().encode('sand'), nodeKey: 'argon2' });

            const dry = await runCommand(['migrate-node-keys', 'Photos', '--dry-run', '--state-dir', stateDir, '--fake-drive', driveDir], {}, capture(lines));
            expect(dry.code).toBe(0);
            expect(lines).toEqual(['would migrate Photos/beach.jpg', 'Dry run: 1 to migrate, 0 already v4, 0 failed.']);
            expect(drive.nodeAt('Photos/beach.jpg').nodeKeyVersion).toBe(6);

            lines.length = 0;
            const real = await runCommand(['migrate-node-keys', 'Photos', '--state-dir', stateDir, '--fake-drive', driveDir], {}, capture(lines));
            expect(real.code).toBe(0);
            expect(lines).toEqual(['migrated Photos/beach.jpg', '1 migrated, 0 finished from an earlier run, 0 already v4, 0 failed.']);
            expect(drive.nodeAt('Photos/beach.jpg').nodeKeyVersion).toBe(4);
        });
    });

    test('a file that fails makes the exit 1', async () => {
        await withDrives(async (stateDir, driveDir, lines) => {
            await signIn(stateDir, driveDir);
            const drive = FakeDrive.open(driveDir);
            drive.add('Photos/beach.jpg', { type: 'file', content: new TextEncoder().encode('sand'), nodeKey: 'argon2' });
            drive.add(`Photos/beach.jpg${TEMPORARY_SUFFIX}`, { type: 'file', content: new TextEncoder().encode('x'), nodeKey: 'argon2' });
            const answer = await runCommand(['migrate-node-keys', 'Photos', '--state-dir', stateDir, '--fake-drive', driveDir], {}, capture(lines));
            expect(answer.code).toBe(1);
            expect(lines.at(-1)).toContain('1 failed');
        });
    });

    test('with the real Drive the state lock is taken: a live holder refuses the command', async () => {
        const stateDir = mkdtempSync(join(tmpdir(), 'pdm-main-migrate-lock-XXXXXX'));
        try {
            await Bun.write(join(stateDir, 'lock.pid'), `${process.pid}\n`);
            await expect(runCommand(['migrate-node-keys', 'Photos', '--state-dir', stateDir], {})).rejects.toThrow();
        } finally {
            await rmAsync(stateDir, { recursive: true, force: true });
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

    test('deletes the session file and says Proton keeps the session until it expires', async () => {
        const stateDir = mkdtemp('logout');
        const store = new SessionFileStore(stateDir);
        await store.save(storedSession());
        const printed: string[] = [];
        const code = await authLogout(stateDir, { print: (line) => printed.push(line), error: () => {} });
        expect(code).toBe(0);
        expect(await store.load()).toBeNull();
        expect(printed.join('\n')).toContain('Proton keeps the session until it expires');
    });

    test('refuses while another process holds the state lock, naming its pid, and keeps the session file', async () => {
        const stateDir = mkdtemp('logout-locked');
        const store = new SessionFileStore(stateDir);
        await store.save(storedSession());
        const release = await acquireStateLock(stateDir);
        try {
            await expect(authLogout(stateDir, { print: () => {}, error: () => {} })).rejects.toThrow(`pid ${process.pid}`);
        } finally {
            await release();
        }
        expect(await store.load()).not.toBeNull();
    });

    test('deletes the saved listings too, since they hold the file names', async () => {
        const stateDir = mkdtemp('logout-listings');
        await new SessionFileStore(stateDir).save(storedSession());
        const cache = new ListingCacheFile(stateDir);
        await cache.write({ rootUid: 'root', eventScopeId: 'volume', lastEventId: 'event-1', listings: new Map([['root', []]]) });
        await authLogout(stateDir, { print: () => {}, error: () => {} });
        expect(await cache.read()).toBeUndefined();
    });

    test('without a session it says so and exits 0', async () => {
        const printed: string[] = [];
        const code = await authLogout(mkdtemp('logout-empty'), { print: (line) => printed.push(line), error: () => {} });
        expect(code).toBe(0);
        expect(printed.join('\n')).toContain('Not signed in');
    });

    test('runCommand dispatches auth logout with the state dir', async () => {
        const stateDir = mkdtemp('logout-dispatch');
        const store = new SessionFileStore(stateDir);
        await store.save(storedSession());
        const answer = await runCommand(['auth', 'logout', '--state-dir', stateDir], {}, CONSOLE_OUTPUT_QUIET);
        expect(answer.code).toBe(0);
        expect(await store.load()).toBeNull();
    });
});
