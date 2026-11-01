import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import { VERSION as SDK_VERSION } from '@protontech/drive-sdk';

import { ApiClient, initAccount, type Logger } from '../../vendor/proton-drive-sdk-account';
import type { Auth } from '../../vendor/proton-drive-sdk-account';
import { startReceiveArm, type ReceiveArm } from '../../fake-drive/receive-arm.ts';
import { APP_VERSION } from '../version';
import { FileCredentials } from '../session/credentials';
import { SessionFileStore } from '../session/store';

/** Third-party clients sign in as `external-drive`; `cli-drive` is reserved for Proton's own CLI. */
export const AUTH_CLIENT_ID = 'external-drive';
const DEFAULT_BASE_URL = 'drive-api.proton.me';

/**
 * The parts of a Proton connection that signing in needs: the account module's
 * `Auth` and the session credentials it saves through. `stop()` ends whatever
 * the connection started (the fake drive's control channel, if any).
 */
export type Connection = {
    auth: Pick<Auth, 'isLoggedIn' | 'loadSession' | 'logout' | 'authViaWeb'>;
    credentials: FileCredentials;
    stop(): Promise<void>;
};

/**
 * Signs the account module in: either the vendored one, against Proton, or the
 * fake drive's stand-in when `--fake-drive DIR` says the account lives there.
 * Loading a session makes no network call; the first API call refreshes.
 */
export async function connect(options: {
    stateDir: string;
    logger: Logger;
    /** The fake drive's directory; the account and the Drive then come from the Receive arm. */
    fakeDriveDir?: string;
    /** The fake drive's control channel, once the Receive arm has started it. */
    onControlUrl?: (url: URL) => void;
}): Promise<Connection> {
    const { stateDir, logger, fakeDriveDir } = options;
    const store = new SessionFileStore(stateDir);
    const credentials = new FileCredentials(store, APP_VERSION);

    if (fakeDriveDir !== undefined) {
        const arm: ReceiveArm = await startReceiveArm(fakeDriveDir);
        try {
            options.onControlUrl?.(arm.controlUrl);
            const { auth } = await arm.account.initAccount({ authClientId: AUTH_CLIENT_ID, credentials, logger });
            return { auth, credentials, stop: () => arm.stop() };
        } catch (error: unknown) {
            await arm.stop();
            throw error;
        }
    }

    initCryptoProxy();
    const apiClient = new ApiClient({
        baseUrl: DEFAULT_BASE_URL,
        appVersion: APP_VERSION,
        credentials,
        logger,
        headers: { 'x-pm-drive-sdk-version': `js@${SDK_VERSION}` },
    });
    const { auth } = await initAccount({
        authClientId: AUTH_CLIENT_ID,
        apiClient,
        credentials,
        cryptoProxy: CryptoProxy,
        srpApi: { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp },
        logger,
    });
    return { auth, credentials, stop: async () => {} };
}

let cryptoReady = false;

function initCryptoProxy() {
    if (cryptoReady) {
        return;
    }
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
    cryptoReady = true;
}
