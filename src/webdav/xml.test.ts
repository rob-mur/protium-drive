import { describe, expect, test } from 'bun:test';

import type { Entry } from '../drive/entry.ts';
import { etagFor, escapeXml, multistatus } from './xml.ts';

function entry(overrides: Partial<Entry> = {}): Entry {
    return {
        uid: 'uid-1',
        name: 'Docs & <notes>',
        kind: 'folder',
        size: 0,
        modified: new Date('2026-02-01T03:04:05Z'),
        created: new Date('2026-01-01T00:00:00Z'),
        treeEventScopeId: 'volume-1',
        ...overrides,
    };
}

describe('escapeXml', () => {
    test('escapes the characters XML reserves', () => {
        expect(escapeXml(`<a & "b" 'c'>`)).toBe('&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
    });
});

describe('etagFor', () => {
    test('a file etag names its revision; a folder etag is weak', () => {
        expect(etagFor(entry({ kind: 'file', revisionUid: 'rev-9' }))).toBe('"rev-9"');
        expect(etagFor(entry())).toBe(`W/"uid-1-${new Date('2026-02-01T03:04:05Z').getTime()}"`);
    });
});

describe('multistatus', () => {
    test('the target comes first, then one response per child', () => {
        const body = multistatus(['Docs'], entry(), [
            entry({ uid: 'uid-2', name: 'note.txt', kind: 'file', size: 3, parentUid: 'uid-1' }),
            entry({ uid: 'uid-3', name: 'Photos', parentUid: 'uid-1' }),
        ]);
        expect(body).toStartWith('<?xml version="1.0" encoding="utf-8"?>');
        expect(body).toContain('<D:multistatus xmlns:D="DAV:">');
        expect(body).toContain('<D:href>/Docs/</D:href>');
        expect(body).toContain('<D:displayname>Docs &amp; &lt;notes&gt;</D:displayname>');
        expect(body.indexOf('/Docs/')).toBeLessThan(body.indexOf('/Docs/note.txt'));
        expect(body).toContain('<D:getcontentlength>3</D:getcontentlength>');
        expect(body).toContain('<D:resourcetype><D:collection/></D:resourcetype>');
    });
});
