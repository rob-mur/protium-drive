import { CryptoProxy } from '@protontech/crypto';

import { initCryptoWorker } from '../src/proton/crypto-pool';

import { makeNodeKeys, type KeyKind, type NodeKey } from './keys';
import { summarize, timed, type Summary } from './stats';

export type CryptoRow = {
    kind: KeyKind;
    keys: number;
    /** Per-key import time, one key at a time. */
    perKey: Summary;
    sequentialMs: number;
    /** All keys sent at once. A single worker makes this the same as `sequentialMs` when the cost is serial. */
    concurrentMs: number;
};

/** Imports a key through the worker and forgets it, as a listing does for each file. */
export async function importNodeKey(key: NodeKey): Promise<void> {
    await CryptoProxy.importPrivateKey({ armoredKey: key.armoredKey, passphrase: key.passphrase });
}

/** Times `CryptoProxy.importPrivateKey` through the real crypto worker, per key kind and count. */
export async function benchCrypto(sizes: number[], kinds: KeyKind[], distinct: number): Promise<CryptoRow[]> {
    initCryptoWorker();
    const rows: CryptoRow[] = [];
    for (const kind of kinds) {
        for (const keys of sizes) {
            const pool = await makeNodeKeys(kind, keys, distinct);
            await importNodeKey(pool[0]); // warm the worker
            await CryptoProxy.clearKeyStore();

            const samples: number[] = [];
            const sequential = await timed(async () => {
                for (const key of pool) {
                    samples.push((await timed(() => importNodeKey(key))).ms);
                }
            });
            await CryptoProxy.clearKeyStore();
            const concurrent = await timed(() => Promise.all(pool.map(importNodeKey)));
            await CryptoProxy.clearKeyStore();
            rows.push({ kind, keys, perKey: summarize(samples), sequentialMs: sequential.ms, concurrentMs: concurrent.ms });
        }
    }
    return rows;
}
