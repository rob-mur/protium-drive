import type { SessionCredentials, SessionInfo } from '../../vendor/proton-drive-sdk-account';
import type { SessionFileStore, StoredSession } from './store';

/**
 * Session state for the account module, persisted by `SessionFileStore`.
 *
 * The account module calls `signOut()` when Proton refuses the refresh token.
 * That clears the session in memory but keeps the file with a marker, because
 * the module also signs out on transient 4xx answers (for example from a
 * captive portal). Only `forget()` (the `auth logout` command) deletes the file.
 */
export class FileCredentials implements SessionCredentials {
    private userKeyPassword?: string;
    private sessionInfo?: SessionInfo;
    private refreshRejectedAt?: string;
    private readonly callbacks = new Set<() => void>();

    constructor(
        private readonly store: SessionFileStore,
        private readonly appVersion: string,
    ) {}

    get uid(): string | undefined {
        return this.sessionInfo?.uid;
    }

    get accessToken(): string | undefined {
        return this.sessionInfo?.accessToken;
    }

    get refreshToken(): string | undefined {
        return this.sessionInfo?.refreshToken;
    }

    get rejectedAt(): string | undefined {
        return this.refreshRejectedAt;
    }

    on(_event: 'sessionInfoChanged', callback: () => void): void {
        this.callbacks.add(callback);
    }

    isLoggedIn(): boolean {
        return !!this.userKeyPassword && !!this.sessionInfo;
    }

    isTelemetryEnabled(): boolean {
        // This client never sends telemetry to Proton.
        return false;
    }

    getUserKeyPassword(): string | undefined {
        return this.userKeyPassword;
    }

    async load(): Promise<void> {
        const stored = await this.store.load();
        if (!stored) {
            return;
        }
        this.refreshRejectedAt = stored.refreshRejectedAt;
        if (stored.refreshRejectedAt) {
            // Keep the file, but do not use a session Proton already refused.
            return;
        }
        this.userKeyPassword = stored.userKeyPassword;
        this.sessionInfo = stored.session;
        this.notify();
    }

    async setUserKeyPassword(userKeyPassword: string): Promise<void> {
        this.userKeyPassword = userKeyPassword;
        await this.persist();
        this.notify();
    }

    async setSessionInfo(info: SessionInfo): Promise<void> {
        this.sessionInfo = info;
        this.refreshRejectedAt = undefined;
        await this.persist();
        this.notify();
    }

    async setTelemetryEnabled(_enabled: boolean): Promise<void> {}

    async signOut(): Promise<void> {
        const snapshot = this.snapshot();
        this.userKeyPassword = undefined;
        this.sessionInfo = undefined;
        this.refreshRejectedAt = new Date().toISOString();
        if (snapshot) {
            await this.store.save({ ...snapshot, refreshRejectedAt: this.refreshRejectedAt });
        }
        this.notify();
    }

    /** Deletes the local session file. Proton keeps the session until it expires or you revoke it. */
    async forget(): Promise<boolean> {
        this.userKeyPassword = undefined;
        this.sessionInfo = undefined;
        this.refreshRejectedAt = undefined;
        this.notify();
        return this.store.remove();
    }

    private snapshot(): StoredSession | undefined {
        if (!this.userKeyPassword || !this.sessionInfo) {
            return undefined;
        }
        return {
            version: 1,
            appVersion: this.appVersion,
            savedAt: new Date().toISOString(),
            userKeyPassword: this.userKeyPassword,
            session: this.sessionInfo,
        };
    }

    private async persist(): Promise<void> {
        const snapshot = this.snapshot();
        if (snapshot) {
            await this.store.save(snapshot);
        }
    }

    private notify(): void {
        for (const callback of this.callbacks) {
            callback();
        }
    }
}
