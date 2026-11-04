import { describe, expect, test } from 'bun:test';
import { encryptKey, enums, generateKey } from 'openpgp';

import { armoredNodeKey } from '../../fake-drive/node-keys.ts';
import { describeNodeKey, needsMigration } from './node-key.ts';

type Generated = Omit<Parameters<typeof generateKey>[0], 'userIDs' | 'format'>;

async function lockedKey(options: Generated, lock: 'iterated' | 'argon2'): Promise<string> {
    const { privateKey } = await generateKey({ ...options, userIDs: [{ name: 'Drive key' }], format: 'object' });
    const locked = await encryptKey({
        privateKey,
        passphrase: 'hunter2',
        config: lock === 'argon2' ? { s2kType: enums.s2k.argon2, aeadProtect: true } : { s2kType: enums.s2k.iterated },
    });
    return locked.armor();
}

describe('describeNodeKey', () => {
    test('a key the SDK writes is version 4 with an iterated S2K', () => {
        expect(describeNodeKey(armoredNodeKey('v4'))).toEqual({ version: 4, s2k: 'iterated' });
    });

    test('a key rclone 1.75.0 wrote is version 6 with an Argon2 S2K', () => {
        expect(describeNodeKey(armoredNodeKey('argon2'))).toEqual({ version: 6, s2k: 'argon2' });
    });

    test('a version 4 key can be locked with Argon2 too', async () => {
        const armored = await lockedKey({ type: 'ecc', curve: 'ed25519Legacy' }, 'argon2');
        expect(describeNodeKey(armored)).toEqual({ version: 4, s2k: 'argon2' });
    }, 30_000);

    test('an ECDSA primary key is read past its curve and point', async () => {
        const armored = await lockedKey({ type: 'ecc', curve: 'nistP256' }, 'iterated');
        expect(describeNodeKey(armored)).toEqual({ version: 4, s2k: 'iterated' });
    }, 30_000);

    test('an RSA primary key is read past its modulus and exponent', async () => {
        const armored = await lockedKey({ type: 'rsa', rsaBits: 2048 }, 'argon2');
        expect(describeNodeKey(armored)).toEqual({ version: 4, s2k: 'argon2' });
    }, 60_000);

    test('a key with no lock has no S2K', async () => {
        const { privateKey } = await generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ name: 'Drive key' }], format: 'object' });
        expect(describeNodeKey(privateKey.armor())).toEqual({ version: 4, s2k: 'none' });
    });

    test('a key of an algorithm it cannot step over has an unknown S2K', () => {
        const lines = armoredNodeKey('v4').split('\n');
        const start = lines.indexOf('') + 1;
        const end = lines.findIndex((line) => line.startsWith('='));
        const packets = Buffer.from(lines.slice(start, end).join(''), 'base64');
        // The first packet is a new-format secret key: header (2 octets), version, created (4), algorithm.
        packets[2 + 1 + 4] = 99;
        const armored = [...lines.slice(0, start), packets.toString('base64'), ...lines.slice(end)].join('\n');
        expect(describeNodeKey(armored)).toEqual({ version: 4, s2k: 'unknown' });
    });

    describe('a packet header in each of its forms', () => {
        /** The v4 fixture's first packet, framed as `framing` says, with `padding` octets after its body. */
        function framed(framing: 'old' | 'new-two-octet' | 'new-five-octet', padding = 0): string {
            const lines = armoredNodeKey('v4').split('\n');
            const start = lines.indexOf('') + 1;
            const end = lines.findIndex((line) => line.startsWith('='));
            const all = Buffer.from(lines.slice(start, end).join(''), 'base64');
            const length = all[1]!;
            const body = Buffer.concat([all.subarray(2, 2 + length), Buffer.alloc(padding)]);
            const rest = all.subarray(2 + length);
            const total = body.length;
            let header: Buffer;
            if (framing === 'old') header = Buffer.from([0x80 | (5 << 2), total]);
            else if (framing === 'new-two-octet') header = Buffer.from([0xc5, 192 + ((total - 192) >> 8), (total - 192) & 0xff]);
            else header = Buffer.concat([Buffer.from([0xc5, 0xff]), Buffer.from([total >>> 24, (total >>> 16) & 0xff, (total >>> 8) & 0xff, total & 0xff])]);
            const packets = Buffer.concat([header, body, rest]);
            return [...lines.slice(0, start), packets.toString('base64'), ...lines.slice(end)].join('\n');
        }

        test('an old-format header with a one-octet length', () => {
            expect(describeNodeKey(framed('old'))).toEqual({ version: 4, s2k: 'iterated' });
        });

        test('a new-format header with a two-octet length', () => {
            expect(describeNodeKey(framed('new-two-octet', 100))).toEqual({ version: 4, s2k: 'iterated' });
        });

        test('a new-format header with a five-octet length', () => {
            expect(describeNodeKey(framed('new-five-octet'))).toEqual({ version: 4, s2k: 'iterated' });
        });

        test('a new-format partial length is refused', () => {
            const armored = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${Buffer.from([0xc5, 0xe0, 0x04]).toString('base64')}\n=AAAA\n-----END PGP PRIVATE KEY BLOCK-----`;
            expect(() => describeNodeKey(armored)).toThrow('not an armored OpenPGP key');
        });

        test('an old-format indeterminate length is refused', () => {
            const armored = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${Buffer.from([0x80 | (5 << 2) | 3, 0x04]).toString('base64')}\n=AAAA\n-----END PGP PRIVATE KEY BLOCK-----`;
            expect(() => describeNodeKey(armored)).toThrow('not an armored OpenPGP key');
        });

        test('bytes that open no packet are refused', () => {
            const armored = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${Buffer.from([0x05, 0x04]).toString('base64')}\n=AAAA\n-----END PGP PRIVATE KEY BLOCK-----`;
            expect(() => describeNodeKey(armored)).toThrow('not an armored OpenPGP key');
        });
    });

    test('text that is no armored key is refused', () => {
        expect(() => describeNodeKey('not a key')).toThrow('not an armored OpenPGP key');
        expect(() => describeNodeKey('-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n=AAAA\n-----END PGP PRIVATE KEY BLOCK-----')).toThrow('not an armored OpenPGP key');
    });

    test('a key whose first packet is no secret key is refused', () => {
        // A literal-data packet (tag 11, new format) with a one-octet body.
        const body = Buffer.from([0xcb, 0x01, 0x00]).toString('base64');
        const armored = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${body}\n=AAAA\n-----END PGP PRIVATE KEY BLOCK-----`;
        expect(() => describeNodeKey(armored)).toThrow('not an armored OpenPGP key');
    });
});

describe('needsMigration', () => {
    test('a v6 key does, whatever locks it', () => {
        expect(needsMigration({ version: 6, s2k: 'iterated' })).toBeTrue();
        expect(needsMigration({ version: 6, s2k: 'argon2' })).toBeTrue();
    });

    test('a key locked with Argon2 does, whatever its version', () => {
        expect(needsMigration({ version: 4, s2k: 'argon2' })).toBeTrue();
    });

    test('a v4 key with an iterated lock does not, nor does one whose lock is unknown', () => {
        expect(needsMigration({ version: 4, s2k: 'iterated' })).toBeFalse();
        expect(needsMigration({ version: 4, s2k: 'unknown' })).toBeFalse();
        expect(needsMigration({ version: 4, s2k: 'none' })).toBeFalse();
    });
});
