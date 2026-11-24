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

const APP_VERSION_PATTERN = /^external-drive-[a-z_]+@\d+\.\d+\.\d+(-(stable|beta|alpha))?(\+[0-9A-Za-z.-]+)?$/;

export function isValidAppVersion(value: string): boolean {
    return APP_VERSION_PATTERN.test(value);
}

/**
 * The `x-pm-appversion` value. Proton blocks a bad release by the version in
 * this header, so a release build sends the version from its stamp
 * (`PDM_BUILD_VERSION`, which the Nix wrapper sets from `.cd-release.json`).
 * A build with no stamp, or with a stamp that would break the SDK shape,
 * sends the package.json version.
 */
export function appVersion(env: NodeJS.ProcessEnv = process.env): string {
    const stamped = env.PDM_BUILD_VERSION;
    if (stamped) {
        const value = `external-drive-${CLIENT_NAME}@${stamped}-${CHANNEL}`;
        if (isValidAppVersion(value)) {
            return value;
        }
    }
    return `external-drive-${CLIENT_NAME}@${VERSION}-${CHANNEL}`;
}

export const APP_VERSION = appVersion();

/**
 * The git revision the Nix build embedded, via `--set PDM_BUILD_REVISION` in
 * the package wrapper (`self.rev`, or `self.dirtyRev` for a dirty tree).
 * Outside the Nix build there is nothing honest to name, so it says unknown.
 */
export function buildRevision(env: NodeJS.ProcessEnv = process.env): string {
    return env.PDM_BUILD_REVISION ?? 'unknown';
}

/**
 * What the first line of `--version` gives after the binary's name.
 *
 * A build from a continuous-delivery release archive carries the archive's
 * stamp: the Nix wrapper sets `PDM_BUILD_VERSION` and `PDM_BUILD_DATE` from
 * `.cd-release.json`, so the line takes the rustc shape
 * `1.2.0 (0123abc 2026-10-13)`. Any other build has no release version to give,
 * so its revision (or `unknown`) takes the place of the version. pdm never
 * works a version out itself: it only repeats the stamp.
 */
export function buildIdentity(env: NodeJS.ProcessEnv = process.env): string {
    const revision = buildRevision(env);
    const version = env.PDM_BUILD_VERSION;
    const date = env.PDM_BUILD_DATE;
    if (version && date) {
        return `${version} (${revision.slice(0, 7)} ${date})`;
    }
    return revision;
}
