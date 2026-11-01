import path from 'node:path';

import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import {
    MemoryCache,
    OpenPGPCryptoWithCryptoProxy,
    type ProtonDriveHTTPClientBlobRequest,
    type ProtonDriveHTTPClientJsonRequest,
    ProtonDriveClient,
    VERSION as SDK_VERSION,
} from '@protontech/drive-sdk';

import { processDriveRequirementHeaders, SUPPORTED_REQUIREMENT_MASK_BY_SCOPE } from '../../vendor/proton-drive-cli/apiRequirements';
import { MessageEmitter } from '../../vendor/proton-drive-cli/messageEmitter';
import { createServerTimeAfterResponseHook } from '../../vendor/proton-drive-cli/serverTimeHook';
import { ApiClient, initAccount, type Logger } from '../../vendor/proton-drive-sdk-account';
import type { Auth } from '../../vendor/proton-drive-sdk-account';
import { startReceiveArm, type ReceiveArm } from '../../fake-drive/receive-arm.ts';
import { createTelemetry } from '../logger';
import { APP_VERSION } from '../version';
import { FileCredentials } from '../session/credentials';
import { SessionFileStore } from '../session/store';
import type { DriveSdk } from '../drive/sdk';

/** Third-party clients sign in as `external-drive`; `cli-drive` is reserved for Proton's own CLI. */
export const AUTH_CLIENT_ID = 'external-drive';
const DEFAULT_BASE_URL = 'drive-api.proton.me';
const CLIENT_UID_FILE = 'client-uid';

/**
 * The parts of a Proton connection that the commands need: the account module's
 * `Auth`, the session credentials it saves through, and the Drive client. The
 * Drive client is created lazily, so a command that never touches the Drive
 * (signing in) makes no Drive setup. `stop()` ends whatever the connection
 * started (the fake drive's control channel, if any).
 */
export type Connection = {
    auth: Pick<Auth, 'isLoggedIn' | 'loadSession' | 'logout' | 'authViaWeb'>;
    credentials: FileCredentials;
    createDriveClient(): Promise<DriveSdk>;
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
    /** The fake drive's directory; the account, the clock and the Drive then come from the Receive arm. */
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
            return { auth, credentials, createDriveClient: () => Promise.resolve(arm.client), stop: () => arm.stop() };
        } catch (error: unknown) {
            await arm.stop();
            throw error;
        }
    }

    initCryptoProxy();
    const sdkVersion = `js@${SDK_VERSION}`;
    const apiClient = new ApiClient({
        baseUrl: DEFAULT_BASE_URL,
        appVersion: APP_VERSION,
        credentials,
        logger,
        headers: { 'x-pm-drive-sdk-version': sdkVersion },
        afterResponseHooks: [createServerTimeAfterResponseHook(), createRequirementHook(sdkVersion, logger)],
    });
    const { auth, srp, addresses } = await initAccount({
        authClientId: AUTH_CLIENT_ID,
        apiClient,
        credentials,
        cryptoProxy: CryptoProxy,
        srpApi: { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp },
        logger,
    });
    const createDriveClient = async (): Promise<DriveSdk> =>
        new ProtonDriveClient({
            config: { baseUrl: DEFAULT_BASE_URL, clientUid: await getOrCreateClientUid(stateDir) },
            httpClient: new SdkHttpClient(apiClient),
            entitiesCache: new MemoryCache(),
            cryptoCache: new MemoryCache(),
            account: addresses,
            srpModule: srp,
            openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
            telemetry: createTelemetry(logger),
        });
    return { auth, credentials, createDriveClient, stop: async () => {} };
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

/** Same as the CLI's HTTP client, but with ky retries off: the SDK already retries and backs off on 429. */
class SdkHttpClient {
    constructor(private readonly apiClient: ApiClient) {}

    fetchJson(options: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
        return this.apiClient.authenticatedRequest(options.url, {
            method: options.method,
            ...(options.json !== undefined ? { json: options.json } : {}),
            ...(options.body !== undefined && options.json === undefined ? { body: options.body } : {}),
            headers: options.headers,
            timeout: options.timeoutMs,
            signal: options.signal,
            throwHttpErrors: false,
            retry: 0,
        });
    }

    fetchBlob(options: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
        return this.apiClient.authenticatedRequest(options.url, {
            method: options.method,
            body: options.body,
            headers: options.headers,
            timeout: options.timeoutMs,
            signal: options.signal,
            throwHttpErrors: false,
            retry: 0,
        });
    }
}

function createRequirementHook(sdkVersion: string, logger: Logger) {
    const once = new MessageEmitter();
    const warn = (message: string) =>
        once.emitOnce(message, (msg) => {
            logger.warn(msg);
        });
    return (_request: Request, _options: unknown, response: Response) => {
        processDriveRequirementHeaders(response.headers, {
            clientSdkVersion: sdkVersion,
            supportedRequirementMasksByScope: SUPPORTED_REQUIREMENT_MASK_BY_SCOPE,
            onUnsupportedFeature: (scope, mask) => warn(`Proton says this SDK lacks a required feature for ${scope} (mask ${mask}). Update proton-drive-mount.`),
            onRequiredUpdate: (version) => warn(`Proton requires SDK ${version} or newer (this build uses ${sdkVersion}). Update proton-drive-mount.`),
            onSuggestedUpdate: (version) => warn(`Proton suggests SDK ${version} or newer (this build uses ${sdkVersion}).`),
        });
    };
}

/** `protondrivemount-<uuid>`, kept in the state directory so Proton sees one stable client. */
async function getOrCreateClientUid(stateDir: string): Promise<string> {
    const file = Bun.file(path.join(stateDir, CLIENT_UID_FILE));
    if (await file.exists()) {
        const value = (await file.text()).trim();
        if (value) {
            return value;
        }
    }
    const value = `protondrivemount-${crypto.randomUUID()}`;
    await Bun.write(file, `${value}\n`, { mode: 0o600 });
    return value;
}
