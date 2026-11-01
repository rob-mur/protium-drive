import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod as chmodAsync, rm as rmAsync } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';

import { VERSION as SDK_VERSION } from '@protontech/drive-sdk';

import { VERSION } from './version.ts';

import { HELP, THIRD_PARTY_NOTICE, run, runCommand, versionAnswer } from './main.ts';

const REV = 'b'.repeat(40);
const ENV = { PDM_BUILD_REVISION: REV };

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
        const answer = run(['serve'], ENV);
        expect(answer.code).toBe(2);
        expect(answer.stderr).toContain('Unknown command "serve"');
        expect(answer.stderr).toContain(THIRD_PARTY_NOTICE);
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
