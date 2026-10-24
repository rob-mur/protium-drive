import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { SessionInfo } from '../../vendor/proton-drive-sdk-account';

export const SESSION_FILE_NAME = 'session.json';
const FORMAT_VERSION = 1;

export type StoredSession = {
    version: typeof FORMAT_VERSION;
    /** `x-pm-appversion` the session was created with. */
    appVersion: string;
    savedAt: string;
    userKeyPassword: string;
    session: SessionInfo;
    /** Set when Proton refused the refresh token. The file stays so a transient refusal does not lose it. */
    refreshRejectedAt?: string;
};

/**
 * Keeps the session in one JSON file with mode 0600 in a 0700 directory.
 *
 * The file holds the refresh token and the key password, so it gives full
 * access to the Proton account. Writes go to a temporary file first and then
 * replace the old file, so a crash never leaves half a session on disk.
 */
export class SessionFileStore {
    readonly filePath: string;

    constructor(readonly stateDir: string) {
        this.filePath = path.join(stateDir, SESSION_FILE_NAME);
    }

    async load(): Promise<StoredSession | null> {
        const file = Bun.file(this.filePath);
        if (!(await file.exists())) {
            return null;
        }
        await this.tightenPermissions();
        const parsed = JSON.parse(await file.text()) as Partial<StoredSession>;
        if (
            parsed.version !== FORMAT_VERSION ||
            typeof parsed.userKeyPassword !== 'string' ||
            typeof parsed.session?.uid !== 'string' ||
            typeof parsed.session?.accessToken !== 'string'
        ) {
            throw new Error(`Session file ${this.filePath} is not in a known format. Run "auth logout" and "auth login".`);
        }
        return parsed as StoredSession;
    }

    async save(snapshot: StoredSession): Promise<void> {
        await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
        await chmod(this.stateDir, 0o700);
        const tmpPath = `${this.filePath}.${process.pid}.tmp`;
        await Bun.write(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
        await chmod(tmpPath, 0o600);
        await rename(tmpPath, this.filePath);
    }

    async remove(): Promise<boolean> {
        const existed = await Bun.file(this.filePath).exists();
        await rm(this.filePath, { force: true });
        return existed;
    }

    private async tightenPermissions(): Promise<void> {
        const info = await stat(this.filePath);
        if ((info.mode & 0o077) !== 0) {
            await chmod(this.filePath, 0o600);
        }
    }
}
