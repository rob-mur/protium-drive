import { expect, test } from 'bun:test';

import { FailedPutGuard } from '../../src/webdav/guard';

test('FailedPutGuard protects a path for its window, and a good PUT clears it', () => {
    let now = 0;
    const guard = new FailedPutGuard(1000, () => now);
    guard.protect('a/b.jpg');
    expect(guard.isProtected('a/b.jpg')).toBe(true);
    expect(guard.isProtected('a/c.jpg')).toBe(false);
    now = 999;
    expect(guard.isProtected('a/b.jpg')).toBe(true);
    now = 1000;
    expect(guard.isProtected('a/b.jpg')).toBe(false);

    guard.protect('x');
    guard.release('x');
    expect(guard.isProtected('x')).toBe(false);
});
