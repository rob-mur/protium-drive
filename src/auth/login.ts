import type { Logger } from '../../vendor/proton-drive-sdk-account';

import { type Connection, connect } from '../proton/connect';
import { acquireStateLock } from '../session/lock';
import { SessionFileStore } from '../session/store';
import { APP_VERSION } from '../version';
import { THIRD_PARTY_NOTICE } from '../notice';

export const REPLACE_WARNING =
    'A session already exists in this state directory. Signing in again replaces it.';

/**
 * How many sign-in links one `auth login` prints. Proton limits each link to about 10 minutes,
 * and Proton's own apps print a new link when one times out, up to 3, so as not to load its API.
 */
export const SIGN_IN_LINKS = 3;
/** The account module's error when no one approved a sign-in link in time (authWeb.ts). */
const LINK_TIMED_OUT = 'Authentication timed out';

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
        await signInThroughLinks(connection.auth, print, signal);
        print(`Signed in. Session saved to ${store.filePath} (mode 0600).`);
        return 0;
    } finally {
        await connection.stop();
    }
}

/** Prints a sign-in link and waits for its approval; prints a new link when one times out. */
async function signInThroughLinks(auth: Connection['auth'], print: (line: string) => void, signal?: AbortSignal): Promise<void> {
    for (let link = 1; ; link++) {
        try {
            await auth.authViaWeb((signInUrl) => {
                print('');
                if (link === 1) {
                    print('Open this URL in a browser (any device) and approve the sign-in:');
                    print(signInUrl);
                    print(`Keep this command running. Each link works for about 10 minutes. When one times out, a new link follows, up to ${SIGN_IN_LINKS} links.`);
                } else {
                    print(`The last link timed out. Open this new URL instead (link ${link} of ${SIGN_IN_LINKS}):`);
                    print(signInUrl);
                }
            }, signal);
            return;
        } catch (error: unknown) {
            if (!(error instanceof Error && error.message === LINK_TIMED_OUT)) throw error;
            if (link === SIGN_IN_LINKS) {
                throw new Error(`No one approved the sign-in: all ${SIGN_IN_LINKS} sign-in links timed out. Run protium-drive auth login again.`);
            }
        }
    }
}
