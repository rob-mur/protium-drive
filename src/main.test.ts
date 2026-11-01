import { describe, expect, test } from 'bun:test';

import { VERSION as SDK_VERSION } from '@protontech/drive-sdk';

import { VERSION } from './version.ts';

import { HELP, THIRD_PARTY_NOTICE, run, versionAnswer } from './main.ts';

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
