import { describe, expect, test } from 'bun:test';

import packageJson from '../package.json';
import {
    APP_VERSION,
    CHANNEL,
    CLIENT_NAME,
    VERSION,
    appVersion,
    buildIdentity,
    buildRevision,
    isValidAppVersion,
} from './version.ts';

describe('version', () => {
    test('VERSION is the package.json version', () => {
        expect(VERSION).toBe(packageJson.version);
    });

    test('APP_VERSION names this project honestly in the SDK shape', () => {
        expect(APP_VERSION).toBe(
            `external-drive-${CLIENT_NAME}@${VERSION}-${CHANNEL}`,
        );
        expect(isValidAppVersion(APP_VERSION)).toBe(true);
    });

    test('a release build sends its stamped version to Proton', () => {
        expect(appVersion({ PDM_BUILD_VERSION: '1.2.3', PDM_BUILD_DATE: '2026-10-13' })).toBe(
            `external-drive-${CLIENT_NAME}@1.2.3-${CHANNEL}`,
        );
    });

    test('a build with no release stamp sends the package.json version', () => {
        expect(appVersion({})).toBe(`external-drive-${CLIENT_NAME}@${packageJson.version}-${CHANNEL}`);
        expect(appVersion({ PDM_BUILD_VERSION: '' })).toBe(appVersion({}));
    });

    test('a stamped version that would break the SDK shape falls back to the package.json version', () => {
        for (const stamp of ['1.2', 'v1.2.3', '1.2.3-rc1', '1.2.3 ', 'latest']) {
            const value = appVersion({ PDM_BUILD_VERSION: stamp });
            expect(value).toBe(appVersion({}));
            expect(isValidAppVersion(value)).toBe(true);
        }
    });

    test('the client name is never a Proton or rclone client name', () => {
        expect(CLIENT_NAME).not.toBe('protonmail');
        expect(CLIENT_NAME).not.toBe('rclone');
    });

    test('isValidAppVersion rejects values that do not name a third-party drive client', () => {
        expect(isValidAppVersion('rclone@1.75.0')).toBe(false);
        expect(isValidAppVersion('external-drive-rclone@1.75.0-alpha')).toBe(true);
        expect(isValidAppVersion('external-drive-protondrivemount@0.1-alpha')).toBe(false);
        expect(isValidAppVersion('external-drive-protondrivemount@0.1.0-beta+b1')).toBe(true);
    });

    test('buildRevision reads the revision the Nix wrapper sets', () => {
        const rev = 'a'.repeat(40);
        expect(buildRevision({ PDM_BUILD_REVISION: rev })).toBe(rev);
    });

    test('buildRevision says unknown outside the Nix build', () => {
        expect(buildRevision({})).toBe('unknown');
    });

    test('a git build gives its full revision in place of a version', () => {
        const rev = 'c'.repeat(40);
        expect(buildIdentity({ PDM_BUILD_REVISION: rev })).toBe(rev);
        expect(buildIdentity({ PDM_BUILD_REVISION: `${rev}-dirty` })).toBe(`${rev}-dirty`);
    });

    test('a build outside Nix gives unknown', () => {
        expect(buildIdentity({})).toBe('unknown');
    });

    test('a release build gives the stamped version, the short commit and the commit date', () => {
        const env = {
            PDM_BUILD_REVISION: '0123abc' + 'd'.repeat(33),
            PDM_BUILD_VERSION: '1.2.0',
            PDM_BUILD_DATE: '2026-10-13',
        };
        expect(buildIdentity(env)).toBe('1.2.0 (0123abc 2026-10-13)');
    });

    test('a version without a date is not a release stamp', () => {
        const rev = 'e'.repeat(40);
        expect(buildIdentity({ PDM_BUILD_REVISION: rev, PDM_BUILD_VERSION: '1.2.0' })).toBe(rev);
    });
});
