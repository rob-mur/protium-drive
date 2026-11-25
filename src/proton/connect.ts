import path from 'node:path';

import { CryptoProxy } from '@protontech/crypto';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import {
    OpenPGPCryptoWithCryptoProxy,
    type ProtonDriveHTTPClientBlobRequest,
    type ProtonDriveHTTPClientJsonRequest,
    ProtonDriveClient,
    VERSION as SDK_VERSION,
} from '@protontech/drive-sdk';

import { createServerTimeAfterResponseHook } from '../../vendor/proton-drive-cli/serverTimeHook';
import { ApiClient, initAccount, type Logger } from '../../vendor/proton-drive-sdk-account';
import type { Auth } from '../../vendor/proton-drive-sdk-account';
import { startReceiveArm, type ReceiveArm } from '../../fake-drive/receive-arm.ts';
import type { Clock } from '../../fake-drive/clock.ts';
import { createTelemetry } from '../logger';
import { APP_VERSION } from '../version';
import { FileCredentials } from '../session/credentials';
import { SessionFileStore } from '../session/store';
import type { DriveSdk } from '../drive/sdk';
import { ListingSaver } from '../drive/listing-saver';
import { cacheUnlockedKeys, initCryptoWorker, stopCryptoWorker } from './crypto-pool';
import { UnlockedKeyCache } from './key-cache';
import { systemKeyring } from './keyring';
import { createRequirementHook } from './requirement-hook';
import { createSdkCaches } from './sdk-caches';

/** Third-party clients sign in as `external-drive`; `cli-drive` is reserved for Proton's own CLI. */
export const AUTH_CLIENT_ID = 'external-drive';
const DEFAULT_BASE_URL = 'drive-api.proton.me';
const CLIENT_UID_FILE = 'client-uid';
/** The SDK version this build tells Proton it runs, and compares Proton's requirements against. */
const CLIENT_SDK_VERSION = `js@${SDK_VERSION}`;

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
    /**
     * The clock the product takes, under `--fake-drive`: the 429 back-off reads
     * it so the scenarios can move time. `undefined` runs on the real clock.
     */
    clock?: Clock;
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
            arm.onResponse(createRequirementHook(CLIENT_SDK_VERSION, logger));
            const { auth } = await arm.account.initAccount({ authClientId: AUTH_CLIENT_ID, credentials, logger });
            return {
                auth,
                credentials,
                createDriveClient: () => Promise.resolve(arm.client),
                clock: arm.clock,
                stop: () => arm.stop(),
            };
        } catch (error: unknown) {
            await arm.stop();
            throw error;
        }
    }

    initCryptoWorker();
    const apiClient = new ApiClient({
        baseUrl: DEFAULT_BASE_URL,
        appVersion: APP_VERSION,
        credentials,
        logger,
        headers: { 'x-pm-drive-sdk-version': CLIENT_SDK_VERSION },
        afterResponseHooks: [createServerTimeAfterResponseHook(), createRequirementHook(CLIENT_SDK_VERSION, logger)],
    });
    const { auth, srp, addresses } = await initAccount({
        authClientId: AUTH_CLIENT_ID,
        apiClient,
        credentials,
        cryptoProxy: CryptoProxy,
        srpApi: { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp },
        logger,
    });
    // Opened with the first Drive client, after the account keys are unlocked, so signing in
    // never asks the keyring and the cache holds node keys only.
    let keyCache: { cache: UnlockedKeyCache; saver: ListingSaver } | undefined;
    const createDriveClient = async (): Promise<DriveSdk> => {
        if (keyCache === undefined) {
            const cache = await UnlockedKeyCache.open({ stateDir, keyring: systemKeyring, logger });
            const saver = new ListingSaver({
                state: () => cache.state(),
                save: () => cache.save(),
                onError: (error) => logger.warn(`Could not save the unlocked-key cache: ${errorMessage(error)}`),
            });
            cacheUnlockedKeys(cache);
            saver.start();
            keyCache = { cache, saver };
        }
        return new ProtonDriveClient({
            config: { baseUrl: DEFAULT_BASE_URL, clientUid: await getOrCreateClientUid(stateDir) },
            httpClient: new SdkHttpClient(apiClient),
            ...createSdkCaches({ clearKey: (key) => CryptoProxy.clearKey({ key }) }),
            account: addresses,
            srpModule: srp,
            openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
            telemetry: createTelemetry(logger),
        });
    };
    const stop = async (): Promise<void> => {
        if (keyCache !== undefined) {
            await keyCache.saver.stop();
            await keyCache.cache.save().catch((error: unknown) => logger.warn(`Could not save the unlocked-key cache: ${errorMessage(error)}`));
            cacheUnlockedKeys(undefined);
            keyCache = undefined;
        }
        await stopCryptoWorker();
    };
    return { auth, credentials, createDriveClient, stop };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
