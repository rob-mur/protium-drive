import { describe, expect, test } from 'bun:test';

import packageJson from '../package.json';
import {
    APP_VERSION,
    CHANNEL,
    CLIENT_NAME,
    VERSION,
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
});
