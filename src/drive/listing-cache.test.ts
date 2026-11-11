import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Entry } from './entry.ts';
import { LISTING_CACHE_FILE_NAME, ListingCacheFile, type ListingSnapshot } from './listing-cache.ts';

function stateDir(): string {
    return path.join(mkdtempSync(path.join(tmpdir(), 'listing-cache-')), 'state');
}

const photo: Entry = {
    uid: 'photo-1',
    name: 'IMG_0001.jpg',
    kind: 'file',
    size: 42,
    modified: new Date('2026-01-02T03:04:05.678Z'),
    created: new Date('2026-01-01T00:00:00Z'),
    mediaType: 'image/jpeg',
    sha1: 'abc',
    revisionUid: 'photo-1-rev',
    parentUid: 'photos',
    treeEventScopeId: 'volume-1',
    armoredNodeKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----',
};

const snapshot: ListingSnapshot = {
    rootUid: 'root',
    eventScopeId: 'volume-1',
    lastEventId: 'event-7',
    listings: new Map([['photos', [photo]]]),
};

describe('ListingCacheFile', () => {
    test('a written snapshot reads back whole, dates and all', async () => {
        const cache = new ListingCacheFile(stateDir());
        await cache.write(snapshot);
        const read = await cache.read();
        expect(read).toEqual(snapshot);
        expect(read?.listings.get('photos')?.[0]?.modified).toBeInstanceOf(Date);
    });

    test('the file is listing-cache.json with mode 0600, in a 0700 state dir', async () => {
        const dir = stateDir();
        await new ListingCacheFile(dir).write(snapshot);
        expect(statSync(path.join(dir, LISTING_CACHE_FILE_NAME)).mode & 0o777).toBe(0o600);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
    });

    test('the file carries format version 1', async () => {
        const dir = stateDir();
        await new ListingCacheFile(dir).write(snapshot);
        const raw = JSON.parse(await Bun.file(path.join(dir, LISTING_CACHE_FILE_NAME)).text());
        expect(raw).toMatchObject({ version: 1, rootUid: 'root', eventScopeId: 'volume-1', lastEventId: 'event-7' });
        expect(typeof raw.savedAt).toBe('string');
        expect(raw.listings.photos[0].modified).toBe('2026-01-02T03:04:05.678Z');
    });

    test('a missing file reads as no snapshot', async () => {
        expect(await new ListingCacheFile(stateDir()).read()).toBeUndefined();
    });

    test('a file of another version is ignored, not an error', async () => {
        const dir = stateDir();
        const cache = new ListingCacheFile(dir);
        await cache.write(snapshot);
        const file = path.join(dir, LISTING_CACHE_FILE_NAME);
        const raw = JSON.parse(await Bun.file(file).text());
        writeFileSync(file, JSON.stringify({ ...raw, version: 2 }));
        expect(await cache.read()).toBeUndefined();
    });

    test('a file that is not JSON, or lacks a field, is ignored, not an error', async () => {
        const dir = stateDir();
        const cache = new ListingCacheFile(dir);
        await cache.write(snapshot);
        const file = path.join(dir, LISTING_CACHE_FILE_NAME);
        writeFileSync(file, '{"version":1,');
        expect(await cache.read()).toBeUndefined();
        writeFileSync(file, JSON.stringify({ version: 1, rootUid: 'root', eventScopeId: 'volume-1', listings: {} }));
        expect(await cache.read()).toBeUndefined();
        writeFileSync(
            file,
            JSON.stringify({ version: 1, rootUid: 'root', eventScopeId: 'volume-1', lastEventId: 'event-1', listings: { root: 'x' } }),
        );
        expect(await cache.read()).toBeUndefined();
    });

    test('a version-1 file whose listings are not entries is ignored, not an error', async () => {
        const dir = stateDir();
        const cache = new ListingCacheFile(dir);
        await cache.write(snapshot);
        const file = path.join(dir, LISTING_CACHE_FILE_NAME);
        const raw = JSON.parse(await Bun.file(file).text());
        const good = raw.listings.photos[0];
        const bad: unknown[] = [
            null,
            { ...good, name: undefined },
            { ...good, uid: undefined },
            { ...good, kind: 'album' },
            { ...good, size: '42' },
            { ...good, modified: undefined },
            { ...good, modified: 'not a date' },
            { ...good, created: 'not a date' },
            { ...good, treeEventScopeId: undefined },
            { ...good, parentUid: 7 },
            'photo',
        ];
        for (const entry of bad) {
            writeFileSync(file, JSON.stringify({ ...raw, listings: { photos: [good, entry] } }));
            expect(await cache.read()).toBeUndefined();
        }
        writeFileSync(file, JSON.stringify({ ...raw, listings: null }));
        expect(await cache.read()).toBeUndefined();
    });

    test('a write whose rename fails leaves no temporary file', async () => {
        const dir = stateDir();
        const cache = new ListingCacheFile(dir);
        mkdirSync(path.join(dir, LISTING_CACHE_FILE_NAME), { recursive: true });
        await expect(cache.write(snapshot)).rejects.toThrow();
        expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    test('remove also deletes a temporary file a failed save left', async () => {
        const dir = stateDir();
        const cache = new ListingCacheFile(dir);
        await cache.write(snapshot);
        writeFileSync(path.join(dir, `${LISTING_CACHE_FILE_NAME}.123.tmp`), '{}');
        writeFileSync(path.join(dir, 'session.json'), '{}');
        await cache.remove();
        expect(readdirSync(dir)).toEqual(['session.json']);
    });

    test('remove on a missing state dir is fine', async () => {
        await new ListingCacheFile(stateDir()).remove();
    });

    test('remove deletes the file, and removing a missing file is fine', async () => {
        const cache = new ListingCacheFile(stateDir());
        await cache.write(snapshot);
        await cache.remove();
        expect(await cache.read()).toBeUndefined();
        await cache.remove();
    });
});
