import { spawn } from 'node:child_process';
import type { Stats } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';

/** Why `mount` will not use a mountpoint: the exit status and a message that names it. */
export interface MountpointRefusal {
    code: number;
    message: string;
}

export interface MountpointDeps {
    stat: (path: string) => Promise<Stats>;
    /** Detaches the mount at `path` and gives the exit status. */
    unmount: (path: string) => Promise<number>;
}

/** Lazily unmounts with `fusermount3`, the tool rclone mounts with, from `PATH`. */
export function fusermountUnmount(path: string): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn('fusermount3', ['-u', '-z', path], { stdio: ['ignore', 'inherit', 'inherit'] });
        child.once('error', () => resolve(127));
        child.once('close', (code) => resolve(code ?? 1));
    });
}

const MOUNTPOINT_DEPS: MountpointDeps = { stat, unmount: fusermountUnmount };

/**
 * Makes `path` ready for rclone to mount on: an empty folder. It creates a folder that does not
 * exist and unmounts a mount a killed run left ("Transport endpoint is not connected"). It refuses
 * a path that is not a folder or holds anything with exit 2, fails any other error with exit 1,
 * and gives undefined when ready.
 */
export async function prepareMountpoint(path: string, deps: MountpointDeps = MOUNTPOINT_DEPS): Promise<MountpointRefusal | undefined> {
    try {
        return await checkMountpoint(path, deps);
    } catch (error: unknown) {
        return { code: 1, message: `Cannot use ${path} as the mountpoint: ${error instanceof Error ? error.message : String(error)}` };
    }
}

async function checkMountpoint(path: string, deps: MountpointDeps): Promise<MountpointRefusal | undefined> {
    let found: Stats;
    try {
        found = await statOrUnmount(path, deps);
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
        await mkdir(path, { recursive: true });
        return undefined;
    }
    if (!found.isDirectory()) return { code: 2, message: `${path} is not a folder; mount needs an empty folder.` };
    if ((await readdir(path)).length > 0) return { code: 2, message: `${path} is not empty; mount needs an empty folder.` };
    return undefined;
}

async function statOrUnmount(path: string, deps: MountpointDeps): Promise<Stats> {
    try {
        return await deps.stat(path);
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOTCONN') throw error;
    }
    const code = await deps.unmount(path);
    if (code !== 0) throw new Error(`a killed mount left it mounted, and fusermount3 -u -z exited ${code}`);
    return deps.stat(path);
}

function errorCode(error: unknown): unknown {
    return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}
