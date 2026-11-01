import { describe, expect, test } from 'bun:test';

import { DriveError } from '../drive/errors.ts';
import { parsePath, toHref } from './paths.ts';

describe('parsePath', () => {
    test('splits and decodes the segments of a URL path', () => {
        expect(parsePath('/')).toEqual([]);
        expect(parsePath('/My%20files/a.txt')).toEqual(['My files', 'a.txt']);
    });

    test('rejects segments a Drive file name cannot be', () => {
        for (const pathname of ['/%zz', '/.', '/..', '/a%2Fb', '/a%00b']) {
            expect(() => parsePath(pathname)).toThrow(DriveError);
        }
    });
});

describe('toHref', () => {
    test('folders end with a slash, and segments are percent-encoded', () => {
        expect(toHref([], true)).toBe('/');
        expect(toHref(['My files'], true)).toBe('/My%20files/');
        expect(toHref(['a folder', 'note.txt'], false)).toBe('/a%20folder/note.txt');
    });
});
