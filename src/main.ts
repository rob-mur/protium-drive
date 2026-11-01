#!/usr/bin/env bun
// The identity entry point: --version names the build, --help and `help` print
// the usage with the third-party notice. Everything else comes back one ticket
// at a time, scenario first, through cd-pipeline.
//
// The prototype on branch prototype/webdav-mount (7bff71f) is the behaviour
// reference, and it never merges to main.
import { parseArgs } from 'node:util';

import { VERSION as SDK_VERSION } from '@protontech/drive-sdk';

import { authLogin } from './auth/login.ts';
import { createLogger } from './logger.ts';
import { resolveStateDir } from './paths.ts';
import { THIRD_PARTY_NOTICE } from './notice.ts';
import { APP_VERSION, VERSION, buildRevision } from './version.ts';

export { THIRD_PARTY_NOTICE };

export const HELP = `proton-drive-mount ${VERSION}: serve Proton Drive over local WebDAV.
${THIRD_PARTY_NOTICE}

Usage:
  proton-drive-mount auth login [--state-dir DIR] [--fake-drive DIR]
  proton-drive-mount --version
  proton-drive-mount help

Options:
  --state-dir DIR   Where the session file lives.
                    Default: $XDG_STATE_HOME/proton-drive-mount (~/.local/state/proton-drive-mount).
  --fake-drive DIR  Use the fake drive kept in DIR instead of Proton. Nothing reaches Proton.
`;

export function versionAnswer(env: NodeJS.ProcessEnv = process.env): string {
    return `proton-drive-mount ${VERSION} (rev ${buildRevision(env)}) (x-pm-appversion ${APP_VERSION}, drive-sdk js@${SDK_VERSION})`;
}

export interface Answer {
    code: number;
    stdout: string;
    stderr: string;
}

export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Answer {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean' },
        },
    });
    if (values.version) {
        return { code: 0, stdout: versionAnswer(env), stderr: '' };
    }
    const command = positionals.join(' ');
    if (values.help || command === 'help') {
        return { code: 0, stdout: HELP, stderr: '' };
    }
    // Every command but the interactive ones answers in one message.
    const asked = command === '' ? '' : `Unknown command "${command}".\n\n`;
    return { code: 2, stdout: '', stderr: `${asked}${HELP}` };
}

/** Where a command's own lines go. Default: stdout, as a user sees it. */
export interface Output {
    print(line: string): void;
    error(line: string): void;
}

const CONSOLE_OUTPUT: Output = { print: (line) => console.log(line), error: (line) => console.error(line) };

/**
 * Runs one command, including the ones that stream. `auth login` prints as it
 * goes and keeps running until the approval arrives; the identity commands
 * answer in one message.
 */
export async function runCommand(argv: string[], env: NodeJS.ProcessEnv = process.env, output: Output = CONSOLE_OUTPUT): Promise<Answer> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            'state-dir': { type: 'string' },
            'fake-drive': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean' },
        },
    });
    if (values.version) {
        return { code: 0, stdout: versionAnswer(env), stderr: '' };
    }
    const command = positionals.join(' ');
    if (values.help || command === 'help') {
        return { code: 0, stdout: HELP, stderr: '' };
    }
    if (command === 'auth login') {
        const code = await authLogin({
            stateDir: resolveStateDir(values['state-dir'], env),
            logger: createLogger(env),
            fakeDriveDir: values['fake-drive'],
            print: output.print,
        });
        return { code, stdout: '', stderr: '' };
    }
    return run(argv, env);
}

if (import.meta.main) {
    const abort = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => abort.abort());
    }
    let answer: Answer;
    try {
        answer = await runCommand(process.argv.slice(2), process.env, CONSOLE_OUTPUT);
    } catch (error: unknown) {
        if (abort.signal.aborted) {
            console.error('Signing in was interrupted.');
            process.exit(130);
        }
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
    if (answer.stdout) console.log(answer.stdout);
    if (answer.stderr) console.error(answer.stderr);
    process.exitCode = answer.code;
}
