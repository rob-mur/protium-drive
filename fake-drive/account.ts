/**
 * The Receive arm's Proton account: it stands in for the vendored account module
 * (`vendor/proton-drive-sdk-account`) at the interface the product takes from it, imitated from
 * that module's types. The product hands it its own `SessionCredentials`, so the product's session
 * code (the session file, the save of each rotated refresh token, the refusal mark of `signOut`)
 * runs unchanged. Nothing here reaches Proton: the sign-in URL names `FAKE_ACCOUNT_HOST`, a host
 * that cannot resolve.
 *
 * - `initAccount(options)` is the module's `initAccount`: it loads the product's session and
 *   returns `auth` (an `Auth`) and `apiClient` (the refresh of an `ApiClient`).
 * - `auth.authViaWeb` is the session-fork sign-in: it gives the product a sign-in URL, then waits
 *   until the control channel approves (`POST /account/approve`). The session it issues holds the
 *   refresh token `refresh-1`.
 * - `apiClient.refreshSessionIfPossible` refreshes as the module does. Each refresh rotates the
 *   refresh token (`refresh-1`, then `refresh-2`, ...) and records the token it used. The account
 *   refuses a token that was used already, as Proton does, and refuses the next refresh when the
 *   control channel says so; then the product is signed out, as the module signs it out.
 * - `authorize()` is what the Drive (drive.ts) runs first on every call, as the SDK's HTTP client
 *   meets a 401: an access token that the control channel expired, or that the account never
 *   issued, gets one refresh. When that fails, the call fails with a `ServerError` of status 401.
 *
 * State lives in `DIR/account.json`, so a session that `auth login --fake-drive DIR` saves is one
 * that a later `serve --fake-drive DIR` accepts, also after a restart. A sign-in waits in the
 * process that started it, for that process's control channel.
 */
import { join } from 'node:path';

import { ServerError } from '@protontech/drive-sdk';

import type { ApiClient } from '../vendor/proton-drive-sdk-account/apiClient.ts';
import type { Auth } from '../vendor/proton-drive-sdk-account/auth.ts';
import { generateSignInUrl } from '../vendor/proton-drive-sdk-account/authWeb.ts';
import type { InitAccountOptions } from '../vendor/proton-drive-sdk-account/index.ts';
import type { SessionCredentials } from '../vendor/proton-drive-sdk-account/sessionCredentials.ts';
import type { DriveAuthorizer } from './drive.ts';
import { StateFile } from './state-file.ts';

/** The host of the sign-in URL. `.invalid` never resolves, so the URL cannot reach anything. */
export const FAKE_ACCOUNT_HOST = 'account.fake-drive.invalid';
/** The key password every approved sign-in gives the product. */
export const KEY_PASSWORD = 'fake-drive-key-password';

/** The part of the account module's `Auth` the product uses. */
export type AuthSurface = Pick<Auth, 'isLoggedIn' | 'loadSession' | 'logout' | 'authViaWeb'>;
/** The part of the account module's `ApiClient` the product's session code meets: the refresh. */
export type ApiClientSurface = Pick<ApiClient, 'refreshSessionIfPossible'>;
/** The module's `InitAccountOptions`, less what only a real connection needs (the API client, crypto and SRP). */
export type FakeInitAccountOptions = Pick<InitAccountOptions, 'authClientId' | 'credentials'> & Partial<Pick<InitAccountOptions, 'logger' | 'accountUrl'>>;

export type RefreshRecord = { used: string; outcome: 'rotated' | 'refused' };

/** What the control channel reads (`GET /account`). */
export type AccountReport = {
    signIns: { started: number; approved: number; pending: number };
    refreshes: RefreshRecord[];
    refuseNextRefresh: boolean;
};

/** `DIR/account.json`. */
export type AccountState = {
    format: 1;
    nextSession: number;
    sessions: Record<string, SessionRecord>;
    refuseNextRefresh: boolean;
    signIns: { started: number; approved: number };
    refreshes: RefreshRecord[];
};

type SessionRecord = { number: number; generation: number; accessToken: string; refreshToken: string; accessExpired: boolean };

type Issued = { uid: string; accessToken: string; refreshToken: string };

export class FakeAccount implements DriveAuthorizer {
    private credentials?: SessionCredentials;
    private apiClient?: ApiClientSurface;
    private readonly waiting = new Set<() => void>();

    private constructor(private readonly state: StateFile<AccountState>) {}

    /** Opens the account kept in `dir`, and creates one with no session there if it holds none. */
    static open(dir: string): FakeAccount {
        return new FakeAccount(
            new StateFile<AccountState>(join(dir, 'account.json'), () => ({
                format: 1,
                nextSession: 1,
                sessions: {},
                refuseNextRefresh: false,
                signIns: { started: 0, approved: 0 },
                refreshes: [],
            })),
        );
    }

    // --- the product's side: the account module's interface -----------------

    /** As the module's `initAccount`: it binds the product's credentials and loads its session. */
    async initAccount(options: FakeInitAccountOptions): Promise<{ auth: AuthSurface; apiClient: ApiClientSurface }> {
        const { credentials, authClientId } = options;
        let activeRefresh: Promise<boolean> | null = null;
        const apiClient: ApiClientSurface = {
            // As the module's `ApiClient.refreshSessionIfPossible`.
            refreshSessionIfPossible: async (rejectedAccessToken?: string) => {
                const current = credentials.accessToken;
                if (current && current !== rejectedAccessToken) return true;
                activeRefresh ??= this.refreshFor(credentials).finally(() => {
                    activeRefresh = null;
                });
                return activeRefresh;
            },
        };
        const auth: AuthSurface = {
            isLoggedIn: () => credentials.isLoggedIn(),
            loadSession: () => credentials.load(),
            logout: () => credentials.signOut(),
            authViaWeb: (onSignInUrl, signal) => this.signIn(authClientId, credentials, onSignInUrl, signal),
        };
        this.credentials = credentials;
        this.apiClient = apiClient;
        await auth.loadSession();
        return { auth, apiClient };
    }

    /** Resolves when the bound product's access token is good, after one refresh if needed. */
    async authorize(): Promise<void> {
        const { credentials, apiClient } = this;
        if (!credentials || !apiClient) return;
        const rejected = credentials.accessToken;
        if (this.accepts(credentials)) return;
        if ((await apiClient.refreshSessionIfPossible(rejected)) && this.accepts(credentials)) return;
        throw Object.assign(new ServerError('fake-drive: Invalid access token'), { statusCode: 401 });
    }

    // --- the control channel's side -----------------------------------------

    /** Approves every sign-in that waits in this process. Returns how many. */
    approve(): number {
        const waiting = [...this.waiting];
        this.waiting.clear();
        for (const resolve of waiting) resolve();
        return waiting.length;
    }

    /** Expires the access token of every session. Returns how many. */
    expireAccessToken(): number {
        return this.state.change((state) => {
            const sessions = Object.values(state.sessions);
            for (const session of sessions) session.accessExpired = true;
            return sessions.length;
        });
    }

    refuseNextRefresh(): void {
        this.state.change((state) => {
            state.refuseNextRefresh = true;
        });
    }

    report(): AccountReport {
        const state = this.state.read();
        return {
            signIns: { ...state.signIns, pending: this.waiting.size },
            refreshes: state.refreshes.map((refresh) => ({ ...refresh })),
            refuseNextRefresh: state.refuseNextRefresh,
        };
    }

    // --- internals ------------------------------------------------------------

    private accepts(credentials: SessionCredentials): boolean {
        const session = credentials.uid ? this.state.read().sessions[credentials.uid] : undefined;
        return !!session && !session.accessExpired && session.accessToken === credentials.accessToken;
    }

    /** As the module's `Auth.authViaWeb`, with the approval from the control channel in place of Proton's. */
    private async signIn(
        authClientId: string,
        credentials: SessionCredentials,
        onSignInUrl: (signInUrl: string) => void | Promise<void>,
        signal?: AbortSignal,
    ): Promise<Issued> {
        signal?.throwIfAborted();
        const started = this.state.change((state) => ++state.signIns.started);
        const { signInUrl } = generateSignInUrl(authClientId, `FAKE-${started}`, FAKE_ACCOUNT_HOST);
        // Wait before the URL goes out, so an approval that follows it at once is never lost.
        const waiter = this.waitForApproval(signal);
        try {
            await onSignInUrl(signInUrl);
        } catch (error: unknown) {
            // The URL did not go out, so the sign-in ends here.
            waiter.cancel();
            throw error;
        }
        await waiter.approved;

        const issued = this.state.change((state) => {
            const number = state.nextSession++;
            const session: SessionRecord = { number, generation: 1, accessToken: `access-${number}-1`, refreshToken: 'refresh-1', accessExpired: false };
            state.sessions[`session-${number}`] = session;
            state.signIns.approved++;
            return { uid: `session-${number}`, accessToken: session.accessToken, refreshToken: session.refreshToken };
        });
        // In the module's order.
        await credentials.setUserKeyPassword(KEY_PASSWORD);
        await credentials.setSessionInfo(issued);
        await credentials.setTelemetryEnabled(false);
        return issued;
    }

    /** Waits in `waiting` until approved or aborted. `cancel` takes the wait out with neither. */
    private waitForApproval(signal?: AbortSignal): { approved: Promise<void>; cancel: () => void } {
        let cancel = () => {};
        const approved = new Promise<void>((resolve, reject) => {
            const approve = () => {
                signal?.removeEventListener('abort', abort);
                resolve();
            };
            const abort = () => {
                this.waiting.delete(approve);
                reject(signal?.reason ?? new Error('Aborted'));
            };
            cancel = () => {
                this.waiting.delete(approve);
                signal?.removeEventListener('abort', abort);
            };
            this.waiting.add(approve);
            signal?.addEventListener('abort', abort, { once: true });
        });
        return { approved, cancel };
    }

    /** As the module's `ApiClient.performTokenRefresh`: save the rotated session, or sign out on a refusal. */
    private async refreshFor(credentials: SessionCredentials): Promise<boolean> {
        const refreshToken = credentials.refreshToken;
        if (!refreshToken) return false;
        const issued = this.refresh(credentials.uid, refreshToken);
        if (!issued) {
            await credentials.signOut();
            return false;
        }
        await credentials.setSessionInfo(issued);
        return true;
    }

    /** Proton's side of a refresh: rotate the tokens, or refuse. */
    private refresh(uid: string | undefined, used: string): Issued | undefined {
        return this.state.change((state) => {
            const session = uid ? state.sessions[uid] : undefined;
            const refuse = state.refuseNextRefresh || !session || session.refreshToken !== used;
            state.refuseNextRefresh = false;
            state.refreshes.push({ used, outcome: refuse ? 'refused' : 'rotated' });
            if (refuse) return undefined;
            session.generation++;
            session.accessToken = `access-${session.number}-${session.generation}`;
            session.refreshToken = `refresh-${session.generation}`;
            session.accessExpired = false;
            return { uid: uid!, accessToken: session.accessToken, refreshToken: session.refreshToken };
        });
    }
}
