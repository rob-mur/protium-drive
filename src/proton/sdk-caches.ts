import type { CachedCryptoMaterial, ProtonDriveCryptoCache, ProtonDriveEntitiesCache } from '@protontech/drive-sdk';

import { BoundedCache } from './bounded-cache';

/** Nodes the entities cache holds: a node's metadata is about 1 KiB. */
export const ENTITIES_CACHE_CAPACITY = 10_000;
/** Node keys the crypto cache holds, share keys aside. */
export const CRYPTO_CACHE_CAPACITY = 10_000;
/**
 * How long a key the crypto cache dropped stays in the crypto worker: a listing or a transfer
 * that read the key before the drop may still be using it. The SDK uses a node key within
 * moments of reading it, so a minute is enough. A longer delay costs memory: the worker holds
 * every key dropped within the delay, about 12 KiB each, so a fast walk under a one-hour delay
 * grows as if there were no bound at all.
 */
export const KEY_CLEAR_GRACE_MS = 60 * 1000;

type PrivateKey = NonNullable<CachedCryptoMaterial['nodeKeys']>['key'];

export type SdkCachesOptions = {
    /** Takes a key out of the crypto worker's key store: `CryptoProxy.clearKey`. */
    clearKey: (key: PrivateKey) => Promise<unknown>;
    entitiesCapacity?: number;
    cryptoCapacity?: number;
    graceMs?: number;
    setTimeout?: (run: () => void, ms: number) => unknown;
};

/**
 * The SDK's entity and crypto caches, each with a bound, so memory stays flat over a long walk.
 *
 * Every key the SDK unlocks also sits in the crypto worker's key store until it is cleared, so a
 * node key the crypto cache drops is cleared there too, once the grace delay has passed and no
 * other entry holds it. Share keys are never dropped: there are few, and every node needs one.
 */
export function createSdkCaches(options: SdkCachesOptions): { entitiesCache: ProtonDriveEntitiesCache; cryptoCache: ProtonDriveCryptoCache } {
    const graceMs = options.graceMs ?? KEY_CLEAR_GRACE_MS;
    const later = options.setTimeout ?? ((run, ms) => setTimeout(run, ms).unref());
    const holders = new Map<PrivateKey, number>();
    const keysOf = (value: CachedCryptoMaterial) => [value.nodeKeys?.key, value.shareKey?.key, value.publicShareKey?.key].filter((key) => key !== undefined);

    return {
        entitiesCache: new BoundedCache<string>({ capacity: options.entitiesCapacity ?? ENTITIES_CACHE_CAPACITY }),
        cryptoCache: new BoundedCache<CachedCryptoMaterial>({
            capacity: options.cryptoCapacity ?? CRYPTO_CACHE_CAPACITY,
            pinned: (key) => key.startsWith('shareKey-'),
            onAdd: (value) => {
                for (const key of keysOf(value)) holders.set(key, (holders.get(key) ?? 0) + 1);
            },
            onDrop: (value) => {
                for (const key of keysOf(value)) {
                    const left = (holders.get(key) ?? 1) - 1;
                    if (left > 0) {
                        holders.set(key, left);
                        continue;
                    }
                    holders.delete(key);
                    later(() => {
                        if (!holders.has(key)) options.clearKey(key).catch(() => undefined);
                    }, graceMs);
                }
            },
        }),
    };
}
