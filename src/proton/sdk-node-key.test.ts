import { describe, expect, test } from 'bun:test';

import { NodesCryptoService } from '@protontech/drive-sdk/dist/internal/nodes/cryptoService.js';
import { convertInternalNode } from '@protontech/drive-sdk/dist/transformers.js';

/**
 * The SDK's public nodes leave out a file's node key; `migrate-node-keys` needs its armor to tell a
 * v6 or Argon2-locked key from a v4 one. patches/@protontech%2Fdrive-sdk@0.23.0.patch carries it
 * through `decryptNode` and `convertInternalNode`.
 */
describe('the patched SDK', () => {
    test('decryptNode keeps the armored node key of the node it decrypts', async () => {
        const service = Object.create(NodesCryptoService.prototype) as Record<string, unknown>;
        Object.assign(service, {
            logger: { debug() {} },
            account: { getPublicKeys: async () => [] },
            decryptName: async () => ({ name: { ok: true, value: 'a.txt' }, author: { ok: true, value: 'x' } }),
            decryptKey: async () => ({ passphrase: 'p', key: 'k', passphraseSessionKey: 's', author: { ok: true, value: 'x' } }),
            decryptMembership: async () => undefined,
            decryptHashKey: async () => ({ hashKey: new Uint8Array(), author: { ok: true, value: 'x' } }),
            decryptExtendedAttributes: async () => ({ extendedAttributes: undefined, author: { ok: true, value: 'x' } }),
        });
        const encrypted = {
            uid: 'volume~node',
            encryptedCrypto: { armoredKey: 'ARMORED', folder: { armoredExtendedAttributes: undefined } },
        };

        const { node } = await (service as unknown as NodesCryptoService).decryptNode(encrypted as never, {} as never);

        expect((node as { encryptedCrypto?: unknown }).encryptedCrypto).toEqual({ armoredKey: 'ARMORED' });
    });

    test('convertInternalNode passes the armored node key on to the public node', () => {
        const converted = convertInternalNode({ uid: 'n', encryptedCrypto: { armoredKey: 'ARMORED' } } as never);

        expect(converted.encryptedCrypto).toEqual({ armoredKey: 'ARMORED' });
    });
});
