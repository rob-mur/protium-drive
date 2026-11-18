import { describe, expect, test } from 'bun:test';

import { BoundedCache } from './bounded-cache';

async function keysOf(cache: BoundedCache<string>, keys: string[]): Promise<string[]> {
    const found: string[] = [];
    for await (const result of cache.iterateEntities(keys)) {
        if (result.ok) found.push(result.key);
    }
    return found;
}

describe('a bounded cache', () => {
    test('holds at most its capacity, dropping the entry used least recently', async () => {
        const cache = new BoundedCache<string>({ capacity: 2 });
        await cache.setEntity('a', 'A');
        await cache.setEntity('b', 'B');
        await cache.getEntity('a');
        await cache.setEntity('c', 'C');

        expect(await keysOf(cache, ['a', 'b', 'c'])).toEqual(['a', 'c']);
        expect(cache.size).toBe(2);
    });

    test('hands each dropped value to onDrop: evicted, replaced, removed or cleared', async () => {
        const dropped: string[] = [];
        const cache = new BoundedCache<string>({ capacity: 2, onDrop: (value) => dropped.push(value) });
        await cache.setEntity('a', 'A1');
        await cache.setEntity('a', 'A2');
        await cache.setEntity('a', 'A2');
        await cache.setEntity('b', 'B');
        await cache.setEntity('c', 'C');
        await cache.removeEntities(['b', 'missing']);
        await cache.clear();

        expect(dropped).toEqual(['A1', 'A2', 'B', 'C']);
    });

    test('never evicts a pinned entry, nor counts it against the capacity', async () => {
        const cache = new BoundedCache<string>({ capacity: 1, pinned: (key) => key.startsWith('share-') });
        await cache.setEntity('share-1', 'S');
        await cache.setEntity('a', 'A');
        await cache.setEntity('b', 'B');

        expect(await keysOf(cache, ['share-1', 'a', 'b'])).toEqual(['share-1', 'b']);
    });

    test('finds entries by tag, and forgets the tags of an evicted entry', async () => {
        const cache = new BoundedCache<string>({ capacity: 1 });
        await cache.setEntity('a', 'A', ['parentUid:p']);
        await cache.setEntity('b', 'B', ['parentUid:p']);

        const tagged: string[] = [];
        for await (const result of cache.iterateEntitiesByTag('parentUid:p')) tagged.push(result.key);
        expect(tagged).toEqual(['b']);
    });

    test('a missing entry throws, as the SDK expects', async () => {
        const cache = new BoundedCache<string>({ capacity: 1 });
        await expect(cache.getEntity('nope')).rejects.toThrow();
    });
});
