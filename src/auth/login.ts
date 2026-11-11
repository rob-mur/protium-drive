import type { Logger } from '../../vendor/proton-drive-sdk-account';

import { connect } from '../proton/connect';
import { acquireStateLock } from '../session/lock';
import { SessionFileStore } from '../session/store';
import { APP_VERSION } from '../version';
import { THIRD_PARTY_NOTICE } from '../notice';

export const REPLACE_WARNING =
    'A session already exists in this state directory. Signing in again replaces it.';

export type LoginOptions = {
    stateDir: string;
    logger: Logger;
    /** The fake drive's directory (`--fake-drive`): the account then comes from the Receive arm. */
    fakeDriveDir?: string;
    /** Where the sign-in's lines go. Default: stdout. */
    print?: (line: string) => void;
    /** Aborts the wait for the approval, as SIGINT and SIGTERM do. */
    signal?: AbortSignal;
    /** The fake drive's control channel, once the Receive arm has started it (tests approve through it). */
    onControlUrl?: (url: URL) => void;
};

/**
 * Signs in through the session-fork flow: it prints a sign-in URL, the user
 * approves it in a browser, and it never asks for a password. The session the
 * approval issues is saved whole by the credentials, then the command ends.
 * It holds the state lock throughout, so it cannot replace the session of a
 * running serve or race another sign-in.
 */
export async function authLogin(options: LoginOptions): Promise<number> {
    const { stateDir } = options;
    const print = options.print ?? ((line: string) => console.log(line));
    const store = new SessionFileStore(stateDir);
    const release = await acquireStateLock(stateDir);
    try {
        return await signIn(store, options, print);
    } finally {
        await release();
    }
}

async function signIn(store: SessionFileStore, options: LoginOptions, print: (line: string) => void): Promise<number> {
    const { stateDir, logger, fakeDriveDir, signal } = options;
    const connection = await connect({ stateDir, logger, fakeDriveDir, onControlUrl: options.onControlUrl });
    try {
        if (await store.load()) {
            print(REPLACE_WARNING);
        }
        print(THIRD_PARTY_NOTICE);
        print(`Client: ${APP_VERSION}`);
        await connection.auth.authViaWeb((signInUrl) => {
            print('');
            print('Open this URL in a browser (any device) and approve the sign-in:');
            print(signInUrl);
            print('Keep this command running. It waits up to 10 minutes for the approval...');
        }, signal);
        print(`Signed in. Session saved to ${store.filePath} (mode 0600).`);
        return 0;
    } finally {
        await connection.stop();
    }
}
