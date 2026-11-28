import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { SaxesParser } from 'saxes';

import type { Entry } from '../drive/entry.ts';
import { etagFor, escapeXml, multistatusStream } from './xml.ts';

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

describe('multistatusStream', () => {
    test('the target comes first, then one response per child', async () => {
        const body = await new Response(
            multistatusStream(['Docs'], entry(), [
                entry({ uid: 'uid-2', name: 'note.txt', kind: 'file', size: 3, parentUid: 'uid-1' }),
                entry({ uid: 'uid-3', name: 'Photos', parentUid: 'uid-1' }),
            ]),
        ).text();
        expect(body).toStartWith('<?xml version="1.0" encoding="utf-8"?>');
        expect(body).toContain('<D:multistatus xmlns:D="DAV:">');
        expect(body).toContain('<D:href>/Docs/</D:href>');
        expect(body).toContain('<D:displayname>Docs &amp; &lt;notes&gt;</D:displayname>');
        expect(body.indexOf('/Docs/')).toBeLessThan(body.indexOf('/Docs/note.txt'));
        expect(body).toContain('<D:getcontentlength>3</D:getcontentlength>');
        expect(body).toContain('<D:resourcetype><D:collection/></D:resourcetype>');
    });

    test('onEnd runs once whether the body is read to its end or cancelled', async () => {
        let ends = 0;
        await new Response(multistatusStream([], entry(), [], { onEnd: () => ends++ })).text();
        expect(ends).toBe(1);

        const reader = multistatusStream([], entry(), [entry()], { onEnd: () => ends++ }).getReader();
        await reader.read();
        await reader.cancel();
        expect(ends).toBe(2);
    });
});

/** Parses `body` as strict XML 1.0 and returns the text of every element with `localName`. */
function textsOf(body: string, localName: string): string[] {
    const parser = new SaxesParser({ xmlns: true });
    const texts: string[] = [];
    let current: string | undefined;
    parser.on('opentag', (tag) => {
        if (tag.local === localName) {
            current = '';
        }
    });
    parser.on('text', (text) => {
        if (current !== undefined) {
            current += text;
        }
    });
    parser.on('closetag', (tag) => {
        if (tag.local === localName && current !== undefined) {
            texts.push(current);
            current = undefined;
        }
    });
    parser.write(body).close();
    return texts;
}

/** The whole streamed multistatus body, as one string. */
function multistatus(segments: string[], target: Entry, children: Entry[]): Promise<string> {
    return new Response(multistatusStream(segments, target, children)).text();
}

describe('multistatus with names XML 1.0 forbids', () => {
    test('a control character in a name or media type still gives well-formed XML', async () => {
        const body = await multistatus(['Docs'], entry({ name: 'Docs' }), [
            entry({ uid: 'uid-2', name: 'bad\u0001.txt', kind: 'file', mediaType: 'text/\u001fplain' }),
            entry({ uid: 'uid-3', name: 'ok.txt', kind: 'file' }),
        ]);
        expect(textsOf(body, 'href')).toEqual(['/Docs/', '/Docs/bad%01.txt', '/Docs/ok.txt']);
        expect(textsOf(body, 'displayname')).toEqual(['Docs', 'bad\uFFFD.txt', 'ok.txt']);
        expect(textsOf(body, 'getcontenttype')).toEqual(['text/\uFFFDplain', 'application/octet-stream']);
    });

    test('any Unicode name parses, and its href decodes back to the name', async () => {
        await fc.assert(
            fc.asyncProperty(fc.string({ unit: 'binary', minLength: 1 }), fc.string({ unit: 'binary' }), async (name, mediaType) => {
                const body = await multistatus(['Docs'], entry({ name: 'Docs' }), [
                    entry({ uid: 'uid-2', name, kind: 'file', mediaType }),
                ]);
                const child = textsOf(body, 'href')[1];
                expect(child).toBeDefined();
                expect(decodeURIComponent(child!.slice('/Docs/'.length))).toBe(name);
            }),
        );
    });
});
