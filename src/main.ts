#!/usr/bin/env bun
import { parseArgs } from 'node:util';

import { VERSION as SDK_VERSION } from '@protontech/drive-sdk';

import { startApp } from './app';
import { createLogger } from './logger';
import { resolveStateDir } from './paths';
import { connectProton } from './proton/connect';
import type { FileCredentials } from './session/credentials';
import { acquireStateLock } from './session/lock';
import { SessionFileStore } from './session/store';
import { APP_VERSION, VERSION } from './version';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7395;
const THIRD_PARTY_NOTICE = 'This is a third-party application not officially supported by Proton.';

const HELP = `proton-drive-mount ${VERSION}: serve Proton Drive over local WebDAV.
${THIRD_PARTY_NOTICE}

Usage:
  proton-drive-mount auth login  [--state-dir DIR]
  proton-drive-mount auth status [--state-dir DIR]
  proton-drive-mount auth logout [--state-dir DIR]
  proton-drive-mount serve [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--root PATH] [--state-dir DIR]
  proton-drive-mount --version

Options:
  --state-dir DIR  Where the session file lives.
                   Default: $XDG_STATE_HOME/proton-drive-mount (~/.local/state/proton-drive-mount).
  --host HOST      Address to listen on. Default: ${DEFAULT_HOST}. The server has no
                   authentication of its own; keep it on loopback.
  --port PORT      Port to listen on. Default: ${DEFAULT_PORT}.
  --root PATH      Folder inside "My files" to serve as /. Default: all of My files.

Environment:
  PDM_LOG_LEVEL        debug, info (default), warn or error.
`;

async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            'state-dir': { type: 'string' },
            host: { type: 'string', default: DEFAULT_HOST },
            port: { type: 'string', default: String(DEFAULT_PORT) },
            root: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean' },
        },
    });
    if (values.version) {
        console.log(`proton-drive-mount ${VERSION} (x-pm-appversion ${APP_VERSION}, drive-sdk js@${SDK_VERSION})`);
        return 0;
    }
    const command = positionals.join(' ');
    if (values.help || command === '' || command === 'help') {
        console.log(HELP);
        return values.help || command === 'help' ? 0 : 2;
    }
    const stateDir = resolveStateDir(values['state-dir']);
    switch (command) {
        case 'auth login':
            return authLogin(stateDir);
        case 'auth status':
            return authStatus(stateDir);
        case 'auth logout':
            return authLogout(stateDir);
        case 'serve': {
            const port = Number(values.port);
            if (!Number.isInteger(port) || port < 0 || port > 65535) {
                console.error(`Bad --port ${values.port}`);
                return 2;
            }
            return serve(stateDir, values.host ?? DEFAULT_HOST, port, values.root);
        }
        default:
            console.error(`Unknown command "${command}".\n\n${HELP}`);
            return 2;
    }
}

async function authLogin(stateDir: string): Promise<number> {
    const logger = createLogger();
    const release = await acquireStateLock(stateDir);
    const abort = new AbortController();
    const onSignal = () => abort.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
        // Start from empty credentials: the new key password and session are
        // then saved together, never mixed with the old session.
        const { auth } = await connectProton({ stateDir, logger });
        if (await new SessionFileStore(stateDir).load()) {
            console.log('A session already exists in this state directory. Signing in again replaces it.');
        }
        console.log(THIRD_PARTY_NOTICE);
        console.log(`Client: ${APP_VERSION}`);
        await auth.authViaWeb((signInUrl) => {
            console.log('\nOpen this URL in a browser (any device) and approve the sign-in:');
            console.log(`\n  ${signInUrl}\n`);
            console.log('Keep this command running. It waits up to 10 minutes for the approval...');
        }, abort.signal);
        console.log(`Signed in. Session saved to ${new SessionFileStore(stateDir).filePath} (mode 0600).`);
        return 0;
    } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        await release();
    }
}

/** Reads only the local file. It never calls Proton, so it cannot race a running `serve` for the refresh token. */
async function authStatus(stateDir: string): Promise<number> {
    const store = new SessionFileStore(stateDir);
    const stored = await store.load();
    console.log(`State directory: ${stateDir}`);
    if (!stored) {
        console.log('Not signed in. Run "proton-drive-mount auth login".');
        return 1;
    }
    console.log(`Session file:    ${store.filePath}`);
    console.log(`Session UID:     ${stored.session.uid.slice(0, 8)}…`);
    console.log(`Saved at:        ${stored.savedAt} by ${stored.appVersion}`);
    console.log(`Refresh token:   ${stored.session.refreshToken ? 'present' : 'missing'}`);
    if (stored.refreshRejectedAt) {
        console.log(`Status:          Proton refused the session at ${stored.refreshRejectedAt}. Run "auth login" again.`);
        return 1;
    }
    console.log('Status:          signed in (checked locally; this command makes no Proton call)');
    return 0;
}

async function authLogout(stateDir: string): Promise<number> {
    const release = await acquireStateLock(stateDir);
    try {
        const removed = await new SessionFileStore(stateDir).remove();
        console.log(removed ? 'Removed the local session file.' : 'No local session file to remove.');
        console.log(
            'Proton keeps the session until it expires. To end it now, revoke it in Proton account settings (Security > Session management).',
        );
        return 0;
    } finally {
        await release();
    }
}

async function serve(stateDir: string, host: string, port: number, root?: string): Promise<number> {
    const logger = createLogger();
    const release = await acquireStateLock(stateDir);
    try {
        const { credentials, createDriveClient } = await connectProton({ stateDir, logger });
        await credentials.load();
        const problem = authProblem(credentials);
        if (problem) {
            console.error(problem);
            return 1;
        }
        if (!isLoopback(host)) {
            logger.warn(`Listening on ${host}: anyone who can reach it gets full access to your Drive. Prefer 127.0.0.1.`);
        }
        const sdk = await createDriveClient();
        const app = startApp({ sdk, logger, host, port, root, authProblem: () => authProblem(credentials) });
        logger.info(`${THIRD_PARTY_NOTICE} Client ${APP_VERSION}.`);
        logger.info(`Serving Proton Drive ${root ? `folder /${root}` : 'My files'} at ${app.server.url.href}`);

        await new Promise<void>((resolve) => {
            process.once('SIGINT', () => resolve());
            process.once('SIGTERM', () => resolve());
        });
        logger.info('Stopping');
        await app.stop();
        return 0;
    } finally {
        await release();
    }
}

function authProblem(credentials: FileCredentials): string | undefined {
    if (credentials.isLoggedIn()) {
        return undefined;
    }
    if (credentials.rejectedAt) {
        return `Proton refused the stored session at ${credentials.rejectedAt}. Run "proton-drive-mount auth login" again.`;
    }
    return 'Not signed in to Proton. Run "proton-drive-mount auth login" first.';
}

function isLoopback(host: string): boolean {
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    },
);
