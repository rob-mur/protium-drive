import { homedir } from 'node:os';
import path from 'node:path';

// Old name kept on purpose after the rename to protium-drive (#143): live installs hold state under it.
export const APP_DIR_NAME = 'proton-drive-mount';

/** Resolves the state directory: `--state-dir`, else `$XDG_STATE_HOME/proton-drive-mount`. */
export function resolveStateDir(
    flag: string | undefined,
    env: Record<string, string | undefined> = process.env,
): string {
    if (flag) {
        return path.resolve(flag);
    }
    const xdgState = env.XDG_STATE_HOME || path.join(env.HOME || homedir(), '.local', 'state');
    return path.join(xdgState, APP_DIR_NAME);
}
