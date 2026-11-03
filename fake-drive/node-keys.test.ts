import { describe, expect, test } from 'bun:test';

import { decryptKey, readPrivateKey } from 'openpgp';

import { armoredNodeKey, type NodeKeyKind, nodeKeyVersion } from './node-keys.ts';

const PASSPHRASE = 'fixture-passphrase';

/** The key's packet, with the fields of it these tests read. */
async function packetOf(kind: NodeKeyKind) {
    const key = await readPrivateKey({ armoredKey: armoredNodeKey(kind) });
    return { key, packet: key.keyPacket as unknown as { version: number; s2k?: { type: string } } };
}

describe('the node key fixtures', () => {
    test('a v4 key is a version 4 key locked with an iterated S2K, and unlocks with the fixture passphrase', async () => {
        const { key, packet } = await packetOf('v4');

        expect(packet.version).toBe(4);
        expect(packet.s2k?.type).toBe('iterated');
        expect(key.isDecrypted()).toBe(false);
        expect((await decryptKey({ privateKey: key, passphrase: PASSPHRASE })).isDecrypted()).toBe(true);
    });

    test('an Argon2 key is a version 6 key locked with an Argon2 S2K, as rclone 1.75.0 writes it, and unlocks with the fixture passphrase', async () => {
        const { key, packet } = await packetOf('argon2');

        expect(packet.version).toBe(6);
        expect(packet.s2k?.type).toBe('argon2');
        expect(key.isDecrypted()).toBe(false);
        expect((await decryptKey({ privateKey: key, passphrase: PASSPHRASE })).isDecrypted()).toBe(true);
    }, 30_000);

    test('the version read from the armor agrees with the version in the packet', async () => {
        for (const kind of ['v4', 'argon2'] as const) {
            expect(nodeKeyVersion(armoredNodeKey(kind))).toBe((await packetOf(kind)).packet.version);
        }
    });

    test('a key with no kind given is v4, the version the SDK writes', () => {
        expect(armoredNodeKey()).toBe(armoredNodeKey('v4'));
    });

    test('armor that does not start with an OpenPGP packet has no version', () => {
        expect(() => nodeKeyVersion('-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nAAAAAAAAAAAA\n-----END PGP PRIVATE KEY BLOCK-----')).toThrow();
    });
});
