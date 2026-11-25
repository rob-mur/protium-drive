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
import { ListingCacheFile } from './drive/listing-cache.ts';
import { createLogger, isLogLevel, logLevel } from './logger.ts';
import { resolveStateDir } from './paths.ts';
import { acquireStateLock } from './session/lock.ts';
import { SessionFileStore } from './session/store.ts';
import { THIRD_PARTY_NOTICE } from './notice.ts';
import { migrateNodeKeysCommand } from './migrate.ts';
import { removeKeyCache } from './proton/key-cache.ts';
import { systemKeyring, type Keyring } from './proton/keyring.ts';
import { cacheSettings, DEFAULT_CACHE, mountCommand, mountDeps } from './mount.ts';
import { serveCommand, DEFAULT_HOST, DEFAULT_PORT } from './serve.ts';
import { readCredentialFile } from './credential-file.ts';
import { appVersion, buildIdentity, buildRevision } from './version.ts';

export { THIRD_PARTY_NOTICE };

export const HELP = `protium-drive: serve Proton Drive over local WebDAV.
${THIRD_PARTY_NOTICE}

Usage:
  protium-drive auth login [--state-dir DIR] [--fake-drive DIR]
  protium-drive auth status [--state-dir DIR]
  protium-drive auth logout [--state-dir DIR]
  protium-drive serve [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--credential-file PATH] [--root PATH]
                [--state-dir DIR] [--fake-drive DIR]
  protium-drive mount MOUNTPOINT [--dir-cache-time DURATION] [--vfs-cache-max-size SIZE] [--cache-dir DIR]
                [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--root PATH] [--state-dir DIR] [--fake-drive DIR]
  protium-drive migrate-node-keys FOLDER [--dry-run] [--state-dir DIR] [--fake-drive DIR]
  protium-drive --version
  protium-drive help

Options:
  --log-level LEVEL How much to log on stderr: debug, info, warn or error. Default: info.
                    Every command takes it. mount gives rclone the same level (info and warn
                    give rclone its default, NOTICE) and writes each rclone line as "rclone: LINE".
  --state-dir DIR   Where the session file lives.
                    Default: $XDG_STATE_HOME/proton-drive-mount (~/.local/state/proton-drive-mount).
  --fake-drive DIR  Use the fake drive kept in DIR instead of Proton. Nothing reaches Proton.
  --host HOST       Address for serve to listen on. Default: ${DEFAULT_HOST}. The serve answers only
                    requests that name localhost, 127.0.0.1, ::1 or HOST. Without
                    --credential-file, serve has no password, so keep it on loopback; mount gives
                    rclone a fresh credential each run and refuses every request without it.
  --port PORT       Port for serve to listen on. Default: ${DEFAULT_PORT}.
  --credential-file PATH
                    serve refuses (401) every request that does not carry
                    "Authorization: Bearer TOKEN", where TOKEN is the content of PATH with the
                    whitespace around it trimmed. Give it on a computer that other users share.
                    The token stays off the command line. serve exits 1 when PATH is missing,
                    empty, or open to group or other (chmod 600 PATH). mount ignores it.
  MOUNTPOINT        mount runs the serve and rclone mount, with the tested settings, and mounts
                    the Drive there. SIGINT or SIGTERM stops both and unmounts. mount creates
                    a MOUNTPOINT that does not exist and unmounts one a killed mount left. It
                    refuses (exit 2) a MOUNTPOINT that is not an empty folder. A write waits in
                    the cache folder until it reaches the Drive. A stop does not wait for it: mount
                    logs each file not yet on the Drive, and the next mount with the same cache
                    folder, --state-dir and --root uploads it, on any port, also after a crash.
  --dir-cache-time DURATION
                    How long the mount trusts a folder listing before it asks again, so how soon
                    a change from another device shows. Default: ${DEFAULT_CACHE.dirCacheTime}. Give a long time,
                    such as 1000h, for a mount that only this computer changes.
  --vfs-cache-max-size SIZE
                    The most file content the mount keeps on disk, such as 512M or 6G, or off for
                    no limit. Default: ${DEFAULT_CACHE.vfsCacheMaxSize}. rclone drops a cached file it has not used for 1h.
  --cache-dir DIR   Where the mount keeps its cache. Default: rclone's own, $RCLONE_CACHE_DIR,
                    else $XDG_CACHE_HOME/rclone (~/.cache/rclone). A mount takes over the files an
                    earlier mount with the same --state-dir and --root left in its cache folder, and
                    clears the rest of that mount's cache.
  --root PATH       Folder inside "My files" to serve as /. Default: all of My files.
  FOLDER            migrate-node-keys walks this folder of My files. For each file whose node key is
                    OpenPGP v6 or locked with Argon2 (as rclone 1.75.0 wrote them), it uploads a copy
                    under a temporary name (NAME.pdm-migrating), checks the copy, moves the original
                    to Drive's trash and renames the copy to NAME. A re-run skips files with v4 keys
                    and finishes a copy a stopped run left. Stop the serve and the mount first: it
                    takes the same state lock.
  --dry-run         migrate-node-keys only lists the files it would migrate; it changes nothing.

Environment:
  PDM_LOG_LEVEL     The log level when --log-level is not given. --log-level wins.

Exit status:
  0    Success.
  1    An error, for example another protium-drive process holds the state directory
       (auth login and auth logout refuse while a serve or mount runs).
  2    Usage error.
  3    Needs login: serve or mount has no session, or Proton refused it. Run "auth login",
       then start it again. A user service should not restart on 3.
  130  Interrupted.
`;

/**
 * The `--version` answer, shaped like `rustc -vV`. Tools read only the first
 * line: `protium-drive <version> (<short commit> <date>)` for a release
 * build, `protium-drive <revision>` for any other. The lines under it
 * are `key: value` details.
 */
export function versionAnswer(env: NodeJS.ProcessEnv = process.env): string {
    const lines = [`protium-drive ${buildIdentity(env)}`, `commit-hash: ${buildRevision(env)}`];
    if (env.PDM_BUILD_DATE) {
        lines.push(`commit-date: ${env.PDM_BUILD_DATE}`);
    }
    lines.push(`x-pm-appversion: ${appVersion(env)}`, `drive-sdk: js@${SDK_VERSION}`);
    return lines.join('\n');
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
            'log-level': { type: 'string' },
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
        output.print('Not signed in. Run "protium-drive auth login".');
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
 * Deletes the local session file, and the saved listings and unlocked keys with
 * it, since they hold the account's file names and keys. It never calls Proton, so Proton keeps the
 * session until it expires or the user revokes it there. It takes the state
 * lock, so it refuses while a serve uses the session.
 */
export async function authLogout(stateDir: string, output: Output = CONSOLE_OUTPUT, keyring: Keyring = systemKeyring): Promise<number> {
    const release = await acquireStateLock(stateDir);
    let removed: boolean;
    try {
        removed = await new SessionFileStore(stateDir).remove();
        await new ListingCacheFile(stateDir).remove();
        await removeKeyCache(stateDir, keyring);
    } finally {
        await release();
    }
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
            'dir-cache-time': { type: 'string' },
            'vfs-cache-max-size': { type: 'string' },
            'cache-dir': { type: 'string' },
            'credential-file': { type: 'string' },
            'dry-run': { type: 'boolean' },
            'log-level': { type: 'string' },
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
    const level = logLevel(values['log-level'], env);
    if (!isLogLevel(level)) {
        return { code: 2, stdout: '', stderr: `${level}\n` };
    }
    if (positionals[0] === 'migrate-node-keys') {
        const folder = positionals[1];
        if (positionals.length !== 2 || folder === undefined) {
            return { code: 2, stdout: '', stderr: `Usage: protium-drive migrate-node-keys FOLDER [--dry-run]\n` };
        }
        const code = await migrateNodeKeysCommand({
            stateDir: resolveStateDir(values['state-dir'], env),
            folder,
            dryRun: values['dry-run'] ?? false,
            logger: createLogger(level),
            fakeDriveDir: values['fake-drive'],
            print: output.print,
            error: output.error,
        });
        return { code, stdout: '', stderr: '' };
    }
    if (command === 'auth login') {
        const code = await authLogin({
            stateDir: resolveStateDir(values['state-dir'], env),
            logger: createLogger(level),
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
        let credential: string | undefined;
        if (values['credential-file'] !== undefined) {
            try {
                credential = readCredentialFile(values['credential-file']);
            } catch (error: unknown) {
                return { code: 1, stdout: '', stderr: `${(error as Error).message}\n` };
            }
        }
        const code = await serveCommand({
            stateDir: resolveStateDir(values['state-dir'], env),
            host: values.host ?? DEFAULT_HOST,
            port,
            logger: createLogger(level),
            fakeDriveDir: values['fake-drive'],
            root: values.root,
            signal,
            credential,
        });
        return { code, stdout: '', stderr: '' };
    }
    if (positionals[0] === 'mount') {
        const usage = 'Usage: protium-drive mount MOUNTPOINT [cache options] [serve options]\n';
        const mountpoint = positionals[1];
        if (positionals.length !== 2 || !mountpoint) {
            return { code: 2, stdout: '', stderr: usage };
        }
        const cache = cacheSettings(values, env);
        if (typeof cache === 'string') {
            return { code: 2, stdout: '', stderr: `${cache}\n${usage}` };
        }
        const port = Number(values.port ?? DEFAULT_PORT);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            return { code: 2, stdout: '', stderr: `Bad --port ${values.port}\n` };
        }
        const code = await mountCommand(
            {
                mountpoint,
                cache,
                stateDir: resolveStateDir(values['state-dir'], env),
                host: values.host ?? DEFAULT_HOST,
                port,
                logger: createLogger(level),
                logLevel: level,
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
