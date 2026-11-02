import { afterAll, expect, test } from 'bun:test';

import { CryptoProxy } from '@protontech/crypto';
import { encryptKey, enums, generateKey } from 'openpgp';

import { initCryptoWorker, stopCryptoWorker } from './crypto-pool';

afterAll(stopCryptoWorker);

test('unlocking Argon2-locked keys in the crypto worker leaves the event loop running', async () => {
    const { privateKey } = await generateKey({ type: 'curve25519', userIDs: [{ name: 'k' }], format: 'object', config: { v6Keys: true } });
    const armoredKey = (await encryptKey({ privateKey, passphrase: 'pw', config: { s2kType: enums.s2k.argon2, aeadProtect: true } })).armor();
    initCryptoWorker();

    let worstGapMs = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
        const now = performance.now();
        worstGapMs = Math.max(worstGapMs, now - last);
        last = now;
    }, 5);
    const keys = await Promise.all([1, 2, 3].map(() => CryptoProxy.importPrivateKey({ armoredKey, passphrase: 'pw' })));
    clearInterval(ticker);

    expect(keys.map((key) => key.getVersion())).toEqual([6, 6, 6]);
    expect(worstGapMs).toBeLessThan(150);
}, 60_000);
