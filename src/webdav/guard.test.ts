import { describe, expect, test } from 'bun:test';

import { FAILED_PUT_GUARD_MS, FailedPutGuard } from './guard.ts';

describe('FailedPutGuard', () => {
    test('protects a path for its window, and only that path', () => {
        let now = 0;
        const guard = new FailedPutGuard(1_000, () => now);
        guard.protect('Photos/beach.jpg');
        expect(guard.isProtected('Photos/beach.jpg')).toBe(true);
        expect(guard.isProtected('Photos/other.jpg')).toBe(false);
        now = 999;
        expect(guard.isProtected('Photos/beach.jpg')).toBe(true);
        now = 1_000;
        expect(guard.isProtected('Photos/beach.jpg')).toBe(false);
    });

    test('a successful PUT releases the path at once', () => {
        const guard = new FailedPutGuard(1_000, () => 0);
        guard.protect('Photos/beach.jpg');
        guard.release('Photos/beach.jpg');
        expect(guard.isProtected('Photos/beach.jpg')).toBe(false);
    });

    test('an expired protection can be set again', () => {
        let now = 0;
        const guard = new FailedPutGuard(1_000, () => now);
        guard.protect('x');
        now = 2_000;
        guard.protect('x');
        now = 2_999;
        expect(guard.isProtected('x')).toBe(true);
    });

    test('the window is the 60 s the rclone DELETE needs to be outlasted', () => {
        expect(FAILED_PUT_GUARD_MS).toBe(60_000);
    });
});
