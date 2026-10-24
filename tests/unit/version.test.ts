import { describe, expect, test } from 'bun:test';

import { APP_VERSION, CLIENT_NAME, isValidAppVersion, VERSION } from '../../src/version';
import packageJson from '../../package.json';

describe('x-pm-appversion', () => {
    test('has the shape the SDK README requires', () => {
        expect(APP_VERSION).toBe(`external-drive-protondrivemount@${packageJson.version}-alpha`);
        expect(isValidAppVersion(APP_VERSION)).toBe(true);
        expect(VERSION).toBe(packageJson.version);
    });

    test('names this project, not a Proton or rclone client', () => {
        for (const reserved of ['web-drive', 'cli-drive', 'macos-drive', 'windows-drive', 'android-drive', 'ios-drive', 'rclone']) {
            expect(APP_VERSION).not.toContain(reserved);
        }
        expect(CLIENT_NAME).toMatch(/^[a-z_]+$/);
    });

    test('rejects malformed values', () => {
        expect(isValidAppVersion('external-drive-my-app@1.0.0')).toBe(false);
        expect(isValidAppVersion('web-drive@5.0.0')).toBe(false);
        expect(isValidAppVersion('external-drive-myapp@1.0.0-stable+abc123f')).toBe(true);
    });
});
