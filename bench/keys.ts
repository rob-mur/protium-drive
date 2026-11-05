import { encryptKey, enums, generateKey } from 'openpgp';

/** Which lock a node key carries: what older clients wrote (`v4`) or what rclone 1.75.0 wrote (`v6-argon2`). */
export type KeyKind = 'v4' | 'v6-argon2';

export type NodeKey = { kind: KeyKind; armoredKey: string; passphrase: string };

/**
 * One real node key, locked the way Drive locks it. A `v4` key uses OpenPGP v4 with the
 * iterated S2K; a `v6-argon2` key is the one `src/proton/argon2-node-key.test.ts` builds.
 */
export async function makeNodeKey(kind: KeyKind, passphrase: string): Promise<NodeKey> {
    const { privateKey } = await generateKey({
        type: 'curve25519',
        userIDs: [{ name: 'Drive key' }],
        format: 'object',
        config: { v6Keys: kind === 'v6-argon2' },
    });
    const config =
        kind === 'v6-argon2'
            ? { s2kType: enums.s2k.argon2 as const, aeadProtect: true }
            : { s2kType: enums.s2k.iterated as const };
    const locked = await encryptKey({ privateKey, passphrase, config });
    return { kind, armoredKey: locked.armor(), passphrase };
}

/**
 * `count` keys of one kind drawn from `distinct` real keys, repeated in turn. Locking an Argon2 key
 * costs as much as unlocking one, so a pool keeps a 3000-key run affordable; the worker still
 * unlocks every armored key it is given.
 */
export async function makeNodeKeys(kind: KeyKind, count: number, distinct = 16): Promise<NodeKey[]> {
    const pool: NodeKey[] = [];
    for (let i = 0; i < Math.min(count, distinct); i++) {
        pool.push(await makeNodeKey(kind, `bench-passphrase-${kind}-${i}`));
    }
    return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
}
