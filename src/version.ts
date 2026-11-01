import packageJson from '../package.json';

export const VERSION: string = packageJson.version;

/**
 * Client name sent to Proton in `x-pm-appversion`.
 *
 * The SDK README requires the shape `external-drive-{name}@{semver}-{channel}`,
 * with `{name}` in lowercase letters and underscores. The value must name this
 * project honestly: never a Proton or rclone client name.
 */
export const CLIENT_NAME = 'protondrivemount';
export const CHANNEL = 'alpha';

export const APP_VERSION = `external-drive-${CLIENT_NAME}@${VERSION}-${CHANNEL}`;

const APP_VERSION_PATTERN = /^external-drive-[a-z_]+@\d+\.\d+\.\d+(-(stable|beta|alpha))?(\+[0-9A-Za-z.-]+)?$/;

export function isValidAppVersion(value: string): boolean {
    return APP_VERSION_PATTERN.test(value);
}

/**
 * The git revision the Nix build embedded, via `--set PDM_BUILD_REVISION` in
 * the package wrapper (`self.rev`, or `self.dirtyRev` for a dirty tree).
 * Outside the Nix build there is nothing honest to name, so it says unknown.
 */
export function buildRevision(env: NodeJS.ProcessEnv = process.env): string {
    return env.PDM_BUILD_REVISION ?? 'unknown';
}
