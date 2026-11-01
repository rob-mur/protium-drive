import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const LOCK_FILE_NAME = 'lock.pid';

/**
 * One process per state directory. The refresh token rotates on each refresh,
 * so two processes that share one session file would log each other out.
 */
export async function acquireStateLock(stateDir: string): Promise<() => Promise<void>> {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(stateDir, LOCK_FILE_NAME);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const handle = await open(lockPath, 'wx', 0o600);
            await handle.writeFile(`${process.pid}\n`);
            await handle.close();
            return async () => {
                await rm(lockPath, { force: true });
            };
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
            const pid = await readPid(lockPath);
            if (pid !== undefined && isAlive(pid)) {
                throw inUse(pid, stateDir);
            }
            await removeStaleLock(lockPath, stateDir);
        }
    }
    throw new Error(`Could not take the lock ${lockPath}`);
}

/**
 * Removes a lock whose process is gone. Another process can take over the
 * same stale lock at the same time, so move the file aside first (only one
 * rename wins) and check what was moved: if it is a live lock, put it back.
 */
async function removeStaleLock(lockPath: string, stateDir: string): Promise<void> {
    const aside = `${lockPath}.stale-${process.pid}`;
    try {
        await rename(lockPath, aside);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw error;
    }
    const pid = await readPid(aside);
    if (pid !== undefined && isAlive(pid)) {
        await link(aside, lockPath).catch(() => {});
        await rm(aside, { force: true });
        throw inUse(pid, stateDir);
    }
    await rm(aside, { force: true });
}

async function readPid(file: string): Promise<number | undefined> {
    const pid = Number.parseInt((await readFile(file, 'utf8').catch(() => '')).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function inUse(pid: number, stateDir: string): Error {
    return new Error(
        `Another proton-drive-mount process (pid ${pid}) uses ${stateDir}. Stop it first, or use another --state-dir.`,
    );
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}
