import { describe, expect, test } from 'bun:test';

import { DriveError } from '../../src/drive/errors';
import { resolveStateDir } from '../../src/paths';
import { parsePath, toHref } from '../../src/webdav/paths';

describe('resolveStateDir', () => {
    test('prefers --state-dir', () => {
        expect(resolveStateDir('/tmp/x', { XDG_STATE_HOME: '/state' })).toBe('/tmp/x');
    });

    test('uses $XDG_STATE_HOME', () => {
        expect(resolveStateDir(undefined, { XDG_STATE_HOME: '/state' })).toBe('/state/proton-drive-mount');
    });

    test('falls back to ~/.local/state', () => {
        expect(resolveStateDir(undefined, { HOME: '/home/u' })).toBe('/home/u/.local/state/proton-drive-mount');
    });
});

describe('URL paths', () => {
    test('decodes segments and drops empty ones', () => {
        expect(parsePath('/a%20b//c%C3%A9/')).toEqual(['a b', 'cé']);
        expect(parsePath('/')).toEqual([]);
    });

    test('rejects dot segments and encoded slashes', () => {
        expect(() => parsePath('/a/../b')).toThrow(DriveError);
        expect(() => parsePath('/a%2Fb')).toThrow(DriveError);
        expect(() => parsePath('/%E0%A4%A')).toThrow(DriveError);
    });

    test('round-trips names with reserved characters', () => {
        const segments = ['photos 2026', "it's #1 & 50% (final)?.jpg"];
        const href = toHref(segments, false);
        expect(href).not.toContain('#');
        expect(href).not.toContain('?');
        expect(parsePath(href)).toEqual(segments);
        expect(toHref(['dir'], true)).toBe('/dir/');
        expect(toHref([], true)).toBe('/');
    });
});
