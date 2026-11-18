import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { readCredentialFile } from './credential-file.ts';

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdm-credential-file-XXXXXX'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function credentialFile(content: string, mode = 0o600): string {
    const path = join(dir, 'credential');
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
}

describe('readCredentialFile', () => {
    test('gives the whole file as the credential', () => {
        expect(readCredentialFile(credentialFile('c2VjcmV0LXRva2Vu'))).toBe('c2VjcmV0LXRva2Vu');
    });

    test('trims the whitespace around the credential, such as the newline an editor adds', () => {
        expect(readCredentialFile(credentialFile('  c2VjcmV0 LXRva2Vu\n\n'))).toBe('c2VjcmV0 LXRva2Vu');
    });

    test('takes a file only the owner can read, mode 0400', () => {
        expect(readCredentialFile(credentialFile('token', 0o400))).toBe('token');
    });

    test('refuses a file that does not exist, naming it', () => {
        const path = join(dir, 'absent');
        expect(() => readCredentialFile(path)).toThrow(`The credential file ${path} cannot be read`);
    });

    test('refuses a folder', () => {
        expect(() => readCredentialFile(dir)).toThrow(`The credential file ${dir} is not a file.`);
    });

    test('refuses a FIFO without waiting for a writer', () => {
        const path = join(dir, 'fifo');
        execFileSync('mkfifo', ['-m', '600', path]);
        expect(() => readCredentialFile(path)).toThrow(`The credential file ${path} is not a file.`);
    });

    for (const [name, content] of [
        ['an empty file', ''],
        ['a file of whitespace only', ' \n\t\n'],
    ] as const) {
        test(`refuses ${name}`, () => {
            const path = credentialFile(content);
            expect(() => readCredentialFile(path)).toThrow(`The credential file ${path} is empty.`);
        });
    }

    for (const mode of [0o644, 0o640, 0o620, 0o604, 0o602, 0o601, 0o610, 0o660, 0o666]) {
        const octal = mode.toString(8).padStart(4, '0');
        test(`refuses mode ${octal}, which lets group or other use the file, and says how to fix it`, () => {
            const path = credentialFile('token', mode);
            expect(() => readCredentialFile(path)).toThrow(
                `The credential file ${path} has mode ${octal}: group or other can use it. Run "chmod 600 ${path}".`,
            );
        });
    }

    test('judges the file a symlink points to, not the link', () => {
        const target = credentialFile('token', 0o644);
        const link = join(dir, 'link');
        symlinkSync(target, link);
        expect(() => readCredentialFile(link)).toThrow('has mode 0644');
        chmodSync(target, 0o600);
        expect(readCredentialFile(link)).toBe('token');
    });
});
