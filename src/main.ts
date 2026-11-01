#!/usr/bin/env bun
// The identity entry point: --version names the build, --help and `help` print
// the usage with the third-party notice. Everything else comes back one ticket
// at a time, scenario first, through cd-pipeline.
//
// The prototype on branch prototype/webdav-mount (7bff71f) is the behaviour
// reference, and it never merges to main.
import { parseArgs } from 'node:util';

import { VERSION as SDK_VERSION } from '@protontech/drive-sdk';

import { APP_VERSION, VERSION, buildRevision } from './version.ts';

export const THIRD_PARTY_NOTICE =
    'This is a third-party application not officially supported by Proton.';

export const HELP = `proton-drive-mount ${VERSION}: serve Proton Drive over local WebDAV.
${THIRD_PARTY_NOTICE}

Usage:
  proton-drive-mount --version
  proton-drive-mount help
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
    // No verb exists yet: an empty or unknown command shows the usage instead.
    const asked = command === '' ? '' : `Unknown command "${command}".\n\n`;
    return { code: 2, stdout: '', stderr: `${asked}${HELP}` };
}

if (import.meta.main) {
    const answer = run(process.argv.slice(2));
    if (answer.stdout) console.log(answer.stdout);
    if (answer.stderr) console.error(answer.stderr);
    process.exitCode = answer.code;
}
