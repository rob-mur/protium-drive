import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import {
    type Logger,
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
import { ApiClient, initAccount } from '../../vendor/proton-drive-sdk-account';
import { createTelemetry } from '../logger';
import { FileCredentials } from '../session/credentials';
import { SessionFileStore } from '../session/store';
import { APP_VERSION } from '../version';

/** Third-party clients sign in as `external-drive`; `cli-drive` is reserved for Proton's own CLI. */
const AUTH_CLIENT_ID = 'external-drive';
const DEFAULT_BASE_URL = 'drive-api.proton.me';
const CLIENT_UID_FILE = 'client-uid';

export type ProtonConnection = Awaited<ReturnType<typeof connectProton>>;

/**
 * Wires the vendored account module and the Drive SDK the same way the
 * official CLI does (`cli/src/init.ts`, `cli/src/api/index.ts`), with
 * in-memory SDK caches. Loading makes no network call; the first API call
 * refreshes the access token with the stored refresh token if needed.
 */
export async function connectProton(options: {
    stateDir: string;
    logger: Logger;
    /** Only tests set this, to a local mock. The SDK rules allow only Proton's official API domain. */
    baseUrl?: string;
}) {
    const { stateDir, logger } = options;
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    await mkdir(stateDir, { recursive: true, mode: 0o700 });

    initCryptoProxy();

    const credentials = new FileCredentials(new SessionFileStore(stateDir), APP_VERSION);
    const sdkVersion = `js@${SDK_VERSION}`;
    const apiClient = new ApiClient({
        baseUrl,
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
        accountUrl: accountUrlFromBaseUrl(baseUrl),
    });

    const createDriveClient = async () =>
        new ProtonDriveClient({
            config: { baseUrl, clientUid: await getOrCreateClientUid(stateDir) },
            httpClient: new SdkHttpClient(apiClient),
            entitiesCache: new MemoryCache(),
            cryptoCache: new MemoryCache(),
            account: addresses,
            srpModule: srp,
            openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
            telemetry: createTelemetry(logger),
        });

    return { auth, credentials, apiClient, createDriveClient };
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

/** `drive-api.X` becomes `account.X`, as in the CLI's `config.ts`. */
export function accountUrlFromBaseUrl(baseUrl: string): string {
    const host = baseUrl.replace(/^https?:\/\//, '');
    if (host.startsWith('drive-api.')) {
        return host.replace(/^drive-api\./, 'account.');
    }
    return host.endsWith('.black') ? 'account.proton.black' : 'account.proton.me';
}

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
