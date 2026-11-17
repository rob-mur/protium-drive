import { afterAll, beforeAll, expect, test } from 'bun:test';

import { CryptoProxy } from '@protontech/crypto';
import { encryptKey, enums, generateKey } from 'openpgp';

import { initCryptoWorker, stopCryptoWorker } from './crypto-pool';

/** A node key locked the way `kind` says: what rclone 1.75.0 wrote, or what Proton clients write. */
async function lockedNodeKey(kind: 'argon2' | 'iterated'): Promise<string> {
    const { privateKey } = await generateKey({
        type: 'curve25519',
        userIDs: [{ name: 'k' }],
        format: 'object',
        config: { v6Keys: kind === 'argon2' },
    });
    const config = kind === 'argon2' ? { s2kType: enums.s2k.argon2 as const, aeadProtect: true } : { s2kType: enums.s2k.iterated as const };
    return (await encryptKey({ privateKey, passphrase: 'pw', config })).armor();
}

let argon2Key: string;
let iteratedKey: string;

beforeAll(async () => {
    [argon2Key, iteratedKey] = await Promise.all([lockedNodeKey('argon2'), lockedNodeKey('iterated')]);
    initCryptoWorker();
}, 30_000);

afterAll(stopCryptoWorker);

/** Starts `count` Argon2 unlocks, as a walk does, and records when each one finishes. */
function startWalkUnlocks(count: number) {
    const state = { finished: 0, finishedAtMs: [] as number[] };
    const done = Promise.all(
        Array.from({ length: count }, async () => {
            await CryptoProxy.importPrivateKey({ armoredKey: argon2Key, passphrase: 'pw' });
            state.finished++;
            state.finishedAtMs.push(performance.now());
        }),
    );
    return { state, done };
}

test('unlocking Argon2-locked keys in the crypto worker leaves the event loop running', async () => {
    let worstGapMs = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
        const now = performance.now();
        worstGapMs = Math.max(worstGapMs, now - last);
        last = now;
    }, 5);
    const keys = await Promise.all([1, 2, 3].map(() => CryptoProxy.importPrivateKey({ armoredKey: argon2Key, passphrase: 'pw' })));
    clearInterval(ticker);

    expect(keys.map((key) => key.getVersion())).toEqual([6, 6, 6]);
    expect(worstGapMs).toBeLessThan(150);
}, 60_000);

test('an Argon2-unlocked key encrypts and decrypts', async () => {
    const key = await CryptoProxy.importPrivateKey({ armoredKey: argon2Key, passphrase: 'pw' });

    const { message } = await CryptoProxy.encryptMessage({ textData: 'sand and sea', encryptionKeys: [key] });
    const { data } = await CryptoProxy.decryptMessage({ armoredMessage: message, decryptionKeys: [key] });

    expect(data).toBe('sand and sea');
}, 60_000);

test('a walk gets each Argon2-unlocked key as it is ready, not all of them at the end', async () => {
    const walk = startWalkUnlocks(4);
    await walk.done;

    const [first, , , last] = walk.state.finishedAtMs;
    // Three unlocks of about 0.4 s each come between the first key and the last.
    expect(last! - first!).toBeGreaterThan(500);
}, 60_000);

test('a new key and an encryption finish while a walk’s Argon2 unlocks wait', async () => {
    const walk = startWalkUnlocks(4);

    const key = await CryptoProxy.generateKey({ userIDs: [{ name: 'Drive key' }], type: 'ecc', curve: 'ed25519Legacy' });
    await CryptoProxy.exportPrivateKey({ privateKey: key, passphrase: 'node passphrase' });
    await CryptoProxy.encryptMessage({ binaryData: new Uint8Array(64 * 1024), encryptionKeys: [key], format: 'binary' });
    const unlocksFinishedFirst = walk.state.finished;
    await walk.done;

    expect(unlocksFinishedFirst).toBeLessThan(2);
}, 60_000);

test('a key Proton clients lock with iterated S2K unlocks while a walk’s Argon2 unlocks wait', async () => {
    const walk = startWalkUnlocks(4);

    const key = await CryptoProxy.importPrivateKey({ armoredKey: iteratedKey, passphrase: 'pw' });
    const unlocksFinishedFirst = walk.state.finished;
    await walk.done;

    expect(key.getVersion()).toBe(4);
    expect(unlocksFinishedFirst).toBeLessThan(2);
}, 60_000);
