import { expect, test } from 'bun:test';

import type { CachedCryptoMaterial } from '@protontech/drive-sdk';

import { createSdkCaches } from './sdk-caches';

/** Timers that fire only when the test says so. */
function manualTimers() {
    const pending: (() => void)[] = [];
    return {
        setTimeout: (run: () => void) => {
            pending.push(run);
        },
        fireAll: () => pending.splice(0).forEach((run) => run()),
    };
}

const key = (name: string) => ({ name }) as unknown as NonNullable<CachedCryptoMaterial['nodeKeys']>['key'];
const nodeKeys = (name: string): CachedCryptoMaterial => ({ nodeKeys: { passphrase: 'p', key: key(name), passphraseSessionKey: {} as never } });

test('a node key the crypto cache drops leaves the crypto worker, after a grace delay', async () => {
    const cleared: unknown[] = [];
    const timers = manualTimers();
    const { cryptoCache } = createSdkCaches({ cryptoCapacity: 1, clearKey: async (k) => void cleared.push(k), setTimeout: timers.setTimeout });

    await cryptoCache.setEntity('nodeKeys-a', nodeKeys('A'));
    await cryptoCache.setEntity('nodeKeys-b', nodeKeys('B'));
    expect(cleared).toEqual([]);

    timers.fireAll();
    expect(cleared).toEqual([key('A')]);
});

test('share keys stay, however many node keys come after them', async () => {
    const cleared: unknown[] = [];
    const timers = manualTimers();
    const { cryptoCache } = createSdkCaches({ cryptoCapacity: 1, clearKey: async (k) => void cleared.push(k), setTimeout: timers.setTimeout });

    await cryptoCache.setEntity('shareKey-s', { shareKey: { key: key('S'), passphraseSessionKey: {} as never } });
    await cryptoCache.setEntity('nodeKeys-a', nodeKeys('A'));
    await cryptoCache.setEntity('nodeKeys-b', nodeKeys('B'));
    timers.fireAll();

    expect(cleared).toEqual([key('A')]);
    expect((await cryptoCache.getEntity('shareKey-s')).shareKey?.key).toEqual(key('S'));
});

test('a key the cache holds again under another entry is not cleared', async () => {
    const cleared: unknown[] = [];
    const timers = manualTimers();
    const { cryptoCache } = createSdkCaches({ cryptoCapacity: 2, clearKey: async (k) => void cleared.push(k), setTimeout: timers.setTimeout });
    const shared = nodeKeys('A');

    await cryptoCache.setEntity('nodeKeys-a', shared);
    await cryptoCache.setEntity('nodeKeys-a', { nodeKeys: { ...shared.nodeKeys!, hashKey: new Uint8Array(1) } });
    timers.fireAll();

    expect(cleared).toEqual([]);
});

test('a key that fails to clear does not throw', async () => {
    const timers = manualTimers();
    const { cryptoCache } = createSdkCaches({ cryptoCapacity: 1, clearKey: () => Promise.reject(new Error('gone')), setTimeout: timers.setTimeout });

    await cryptoCache.setEntity('nodeKeys-a', nodeKeys('A'));
    await cryptoCache.setEntity('nodeKeys-b', nodeKeys('B'));

    expect(() => timers.fireAll()).not.toThrow();
});

test('the entities cache is bounded too', async () => {
    const { entitiesCache } = createSdkCaches({ entitiesCapacity: 1, clearKey: async () => {} });

    await entitiesCache.setEntity('node-a', 'A');
    await entitiesCache.setEntity('node-b', 'B');

    await expect(entitiesCache.getEntity('node-a')).rejects.toThrow();
    expect(await entitiesCache.getEntity('node-b')).toBe('B');
});
