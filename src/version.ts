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
