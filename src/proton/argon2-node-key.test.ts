import { afterAll, describe, expect, test } from 'bun:test';

import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { encryptKey, enums, generateKey } from 'openpgp';

/** The key rclone 1.75.0 wrote for every file: OpenPGP v6, locked with Argon2 S2K and AEAD. */
async function argon2LockedNodeKey(passphrase: string): Promise<string> {
    const { privateKey } = await generateKey({
        type: 'curve25519',
        userIDs: [{ name: 'Drive key' }],
        format: 'object',
        config: { v6Keys: true },
    });
    const locked = await encryptKey({
        privateKey,
        passphrase,
        config: { s2kType: enums.s2k.argon2, aeadProtect: true },
    });
    return locked.armor();
}

describe('a node key locked with Argon2', () => {
    afterAll(() => CryptoProxy.releaseEndpoint());

    test('imports through CryptoProxy once the Argon2 guard is patched out', async () => {
        CryptoApi.init({});
        CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
        const armoredKey = await argon2LockedNodeKey('hunter2');

        const imported = await CryptoProxy.importPrivateKey({ armoredKey, passphrase: 'hunter2' });

        expect(imported.getVersion()).toBe(6);
        expect(imported.isPrivate()).toBe(true);
    }, 30_000);
});
