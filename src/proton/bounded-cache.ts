import type { EntityResult, ProtonDriveCache } from '@protontech/drive-sdk';

export type BoundedCacheOptions<T> = {
    /** The most entries the cache holds, not counting pinned ones. */
    capacity: number;
    /** Entries the cache never evicts and does not count; only `removeEntities` and `clear` drop them. */
    pinned?: (key: string) => boolean;
    /** Called with each value the cache takes in; a value set again under the same key is not taken in twice. */
    onAdd?: (value: T) => void;
    /** Called with each value the cache lets go of: evicted, replaced by another value, removed or cleared. */
    onDrop?: (value: T) => void;
};

type Stored<T> = { value: T; tags: string[] };

/**
 * The SDK's entity and crypto caches, in memory with a bound, so a long-running serve stays flat.
 *
 * Each read or write makes an entry the most recently used; past the capacity the least recently
 * used one goes. A dropped entry costs only a reload from Proton. The SDK's own `MemoryCache` has
 * no bound, keeps the tags of removed and cleared entries, and scans every tag on each write.
 */
export class BoundedCache<T> implements ProtonDriveCache<T> {
    /** In use order, least recent first: a Map iterates in insertion order. */
    private readonly entries = new Map<string, Stored<T>>();
    private readonly keysByTag = new Map<string, Set<string>>();
    private unpinned = 0;

    constructor(private readonly options: BoundedCacheOptions<T>) {}

    /** The entries held, pinned ones included. */
    get size(): number {
        return this.entries.size;
    }

    async clear(): Promise<void> {
        const values = [...this.entries.values()];
        this.entries.clear();
        this.keysByTag.clear();
        this.unpinned = 0;
        for (const { value } of values) this.drop(value);
    }

    async setEntity(key: string, value: T, tags: string[] = []): Promise<void> {
        const old = this.detach(key);
        if (old?.value !== value) {
            this.options.onAdd?.(value);
            if (old !== undefined) this.drop(old.value);
        }
        this.entries.set(key, { value, tags });
        for (const tag of tags) {
            let keys = this.keysByTag.get(tag);
            if (keys === undefined) {
                keys = new Set();
                this.keysByTag.set(tag, keys);
            }
            keys.add(key);
        }
        if (!this.isPinned(key)) {
            this.unpinned++;
            this.evict();
        }
    }

    async getEntity(key: string): Promise<T> {
        const stored = this.entries.get(key);
        if (stored === undefined) {
            throw new Error('Entity not found');
        }
        this.entries.delete(key);
        this.entries.set(key, stored);
        return stored.value;
    }

    async *iterateEntities(keys: string[]): AsyncGenerator<EntityResult<T>> {
        for (const key of keys) {
            try {
                yield { key, ok: true, value: await this.getEntity(key) };
            } catch (error) {
                yield { key, ok: false, error: `${error}` };
            }
        }
    }

    async *iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<T>> {
        // A copy, so a change while the caller iterates does not change what it gets.
        yield* this.iterateEntities([...(this.keysByTag.get(tag) ?? [])]);
    }

    async removeEntities(keys: string[]): Promise<void> {
        for (const key of keys) {
            const old = this.detach(key);
            if (old !== undefined) this.drop(old.value);
        }
    }

    private isPinned(key: string): boolean {
        return this.options.pinned?.(key) ?? false;
    }

    /** Takes the entry out of both indexes, without dropping its value. */
    private detach(key: string): Stored<T> | undefined {
        const stored = this.entries.get(key);
        if (stored === undefined) {
            return undefined;
        }
        this.entries.delete(key);
        for (const tag of stored.tags) {
            const keys = this.keysByTag.get(tag);
            keys?.delete(key);
            if (keys?.size === 0) this.keysByTag.delete(tag);
        }
        if (!this.isPinned(key)) this.unpinned--;
        return stored;
    }

    private evict(): void {
        for (const key of this.entries.keys()) {
            if (this.unpinned <= this.options.capacity) {
                return;
            }
            if (!this.isPinned(key)) {
                this.drop(this.detach(key)!.value);
            }
        }
    }

    private drop(value: T): void {
        this.options.onDrop?.(value);
    }
}
