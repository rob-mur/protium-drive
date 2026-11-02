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
import { SessionFileStore } from './session/store.ts';
import { THIRD_PARTY_NOTICE } from './notice.ts';
import { mountCommand, mountDeps } from './mount.ts';
import { serveCommand, DEFAULT_HOST, DEFAULT_PORT } from './serve.ts';
import { APP_VERSION, VERSION, buildRevision } from './version.ts';

export { THIRD_PARTY_NOTICE };

export const HELP = `proton-drive-mount ${VERSION}: serve Proton Drive over local WebDAV.
${THIRD_PARTY_NOTICE}

Usage:
  proton-drive-mount auth login [--state-dir DIR] [--fake-drive DIR]
  proton-drive-mount auth status [--state-dir DIR]
  proton-drive-mount auth logout [--state-dir DIR]
  proton-drive-mount serve [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--root PATH] [--state-dir DIR] [--fake-drive DIR]
  proton-drive-mount mount MOUNTPOINT [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--root PATH] [--state-dir DIR] [--fake-drive DIR]
  proton-drive-mount --version
  proton-drive-mount help

Options:
  --state-dir DIR   Where the session file lives.
                    Default: $XDG_STATE_HOME/proton-drive-mount (~/.local/state/proton-drive-mount).
  --fake-drive DIR  Use the fake drive kept in DIR instead of Proton. Nothing reaches Proton.
  --host HOST       Address for serve to listen on. Default: ${DEFAULT_HOST}. The server has no
                    authentication of its own; keep it on loopback.
  --port PORT       Port for serve to listen on. Default: ${DEFAULT_PORT}.
  MOUNTPOINT        mount runs the serve and rclone mount, with the tested settings, and mounts
                    the Drive there. SIGINT or SIGTERM stops both and unmounts.
  --root PATH       Folder inside "My files" to serve as /. Default: all of My files.
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
 * Reports the saved session from the local file only. It never calls Proton,
 * so it cannot race a running `serve` for the refresh token. It names a session
 * Proton refused and exits 1; a healthy or missing session also exits 1 only
 * when there is nothing to use.
 */
export async function authStatus(stateDir: string, output: Output = CONSOLE_OUTPUT): Promise<number> {
    const store = new SessionFileStore(stateDir);
    const stored = await store.load();
    output.print(`State directory: ${stateDir}`);
    if (!stored) {
        output.print('Not signed in. Run "proton-drive-mount auth login".');
        return 1;
    }
    output.print(`Session file:    ${store.filePath}`);
    output.print(`Session UID:     ${stored.session.uid.slice(0, 8)}…`);
    output.print(`Saved at:        ${stored.savedAt} by ${stored.appVersion}`);
    output.print(`Refresh token:   ${stored.session.refreshToken ? 'present' : 'missing'}`);
    if (stored.refreshRejectedAt) {
        output.print(`Status:          Proton refused the session at ${stored.refreshRejectedAt}. Run "auth login" again.`);
        return 1;
    }
    output.print('Status:          signed in (checked locally; this command makes no Proton call)');
    return 0;
}

/**
 * Deletes the local session file. It never calls Proton, so Proton keeps the
 * session until it expires or the user revokes it there.
 */
export async function authLogout(stateDir: string, output: Output = CONSOLE_OUTPUT): Promise<number> {
    const removed = await new SessionFileStore(stateDir).remove();
    output.print(removed ? 'Signed out: the local session file is deleted.' : 'Not signed in: there was no session file to delete.');
    if (removed) {
        output.print('Proton keeps the session until it expires; revoke it in your Proton account settings to end it sooner.');
    }
    return 0;
}

/**
 * Runs one command, including the ones that stream. `auth login` prints as it
 * goes and keeps running until the approval arrives; the identity commands
 * answer in one message.
 */
export async function runCommand(argv: string[], env: NodeJS.ProcessEnv = process.env, output: Output = CONSOLE_OUTPUT, signal?: AbortSignal): Promise<Answer> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            'state-dir': { type: 'string' },
            'fake-drive': { type: 'string' },
            host: { type: 'string' },
            port: { type: 'string' },
            root: { type: 'string' },
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
            signal,
        });
        return { code, stdout: '', stderr: '' };
    }
    if (command === 'auth status') {
        const code = await authStatus(resolveStateDir(values['state-dir'], env), output);
        return { code, stdout: '', stderr: '' };
    }
    if (command === 'auth logout') {
        const code = await authLogout(resolveStateDir(values['state-dir'], env), output);
        return { code, stdout: '', stderr: '' };
    }
    if (command === 'serve') {
        const port = Number(values.port ?? DEFAULT_PORT);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            return { code: 2, stdout: '', stderr: `Bad --port ${values.port}\n` };
        }
        const code = await serveCommand({
            stateDir: resolveStateDir(values['state-dir'], env),
            host: values.host ?? DEFAULT_HOST,
            port,
            logger: createLogger(env),
            fakeDriveDir: values['fake-drive'],
            root: values.root,
            signal,
        });
        return { code, stdout: '', stderr: '' };
    }
    if (positionals[0] === 'mount') {
        const mountpoint = positionals[1];
        if (positionals.length !== 2 || !mountpoint) {
            return { code: 2, stdout: '', stderr: `Usage: proton-drive-mount mount MOUNTPOINT [serve options]\n` };
        }
        const port = Number(values.port ?? DEFAULT_PORT);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            return { code: 2, stdout: '', stderr: `Bad --port ${values.port}\n` };
        }
        const code = await mountCommand(
            {
                mountpoint,
                stateDir: resolveStateDir(values['state-dir'], env),
                host: values.host ?? DEFAULT_HOST,
                port,
                logger: createLogger(env),
                fakeDriveDir: values['fake-drive'],
                root: values.root,
                signal,
            },
            mountDeps(env),
        );
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
        answer = await runCommand(process.argv.slice(2), process.env, CONSOLE_OUTPUT, abort.signal);
    } catch (error: unknown) {
        if (abort.signal.aborted) {
            console.error('Interrupted.');
            process.exit(130);
        }
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
    if (answer.stdout) console.log(answer.stdout);
    if (answer.stderr) console.error(answer.stderr);
    process.exitCode = answer.code;
}
