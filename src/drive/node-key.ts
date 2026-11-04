/**
 * What an armored node key says about itself, read without unlocking it. rclone 1.75.0 wrote
 * every file's node key as an OpenPGP v6 key locked with Argon2 S2K; every Proton client, and
 * the SDK's uploader, writes a v4 key locked with iterated S2K. The first packet of the key is
 * its secret primary key, and it carries both facts in the clear.
 */
export type NodeKeyDescription = {
    /** The key packet's version octet: 4 or 6. */
    version: number;
    /**
     * How the secret material is locked. `unknown` when the key's algorithm is one this reader
     * cannot step over to find the S2K (a version 6 key needs no stepping, so it never has this).
     */
    s2k: 'none' | 'iterated' | 'argon2' | 'other' | 'unknown';
};

const SECRET_KEY_TAG = 5;
const S2K_TYPE_ARGON2 = 4;
const S2K_TYPE_ITERATED = 3;

/** Whether a file with this node key is one `migrate-node-keys` re-uploads: v6, or locked with Argon2. */
export function needsMigration(key: NodeKeyDescription): boolean {
    return key.version === 6 || key.s2k === 'argon2';
}

export function describeNodeKey(armoredKey: string): NodeKeyDescription {
    const packet = firstPacket(dearmor(armoredKey));
    const version = packet[0]!;
    if (version === 6) {
        return { version, s2k: v6Lock(packet) };
    }
    const usageAt = version === 4 ? publicKeyEnd(packet) : undefined;
    return { version, s2k: usageAt === undefined ? 'unknown' : lockAt(packet, usageAt) };
}

function notAKey(): Error {
    return new Error('The node key is not an armored OpenPGP key');
}

/** The binary packets inside an armored block: the lines between the blank line after the headers and the checksum. */
function dearmor(armored: string): Buffer {
    const lines = armored.split('\n').map((line) => line.trim());
    const begin = lines.findIndex((line) => line.startsWith('-----BEGIN PGP'));
    if (begin < 0) throw notAKey();
    const blank = lines.indexOf('', begin);
    const body: string[] = [];
    for (const line of lines.slice(blank + 1)) {
        if (line.startsWith('=') || line.startsWith('-----')) break;
        body.push(line);
    }
    const bytes = Buffer.from(body.join(''), 'base64');
    if (bytes.length === 0) throw notAKey();
    return bytes;
}

/** The body of the first packet, which must be a secret key. */
function firstPacket(bytes: Buffer): Buffer {
    const header = bytes[0]!;
    if ((header & 0x80) === 0) throw notAKey();
    let tag: number;
    let start: number;
    let length: number;
    if (header & 0x40) {
        tag = header & 0x3f;
        const first = bytes[1]!;
        if (first < 192) {
            [start, length] = [2, first];
        } else if (first < 224) {
            [start, length] = [3, ((first - 192) << 8) + bytes[2]! + 192];
        } else if (first === 255) {
            [start, length] = [6, bytes.readUInt32BE(2)];
        } else {
            throw notAKey();
        }
    } else {
        tag = (header & 0x3c) >> 2;
        const octets = [1, 2, 4][header & 3];
        if (octets === undefined) throw notAKey();
        start = 1 + octets;
        length = bytes.readUIntBE(1, octets);
    }
    if (tag !== SECRET_KEY_TAG) throw notAKey();
    return bytes.subarray(start, start + length);
}

/** A v6 key packet: version, created (4), algorithm, public material length (4), public material, then the lock. */
function v6Lock(packet: Buffer): NodeKeyDescription['s2k'] {
    return lockAt(packet, 1 + 4 + 1 + 4 + packet.readUInt32BE(6), true);
}

/** Where the lock starts in a v4 key packet, after the public key material; `undefined` for an algorithm not stepped over. */
function publicKeyEnd(packet: Buffer): number | undefined {
    const algorithm = packet[5]!;
    let at = 6;
    const mpi = () => {
        at += 2 + Math.ceil(packet.readUInt16BE(at) / 8);
    };
    switch (algorithm) {
        case 1: // RSA: modulus and exponent.
            mpi();
            mpi();
            return at;
        case 19: // ECDSA, and
        case 22: // EdDSA legacy: the curve's OID, then one point.
            at += 1 + packet[at]!;
            mpi();
            return at;
        default:
            return undefined;
    }
}

/**
 * The lock a secret key packet's S2K usage octet at `usageAt` announces. Usage 0 is no lock; 253
 * (AEAD), 254 and 255 carry an S2K specifier after the cipher; any other value is the cipher itself,
 * with the old simple lock.
 */
function lockAt(packet: Buffer, usageAt: number, v6 = false): NodeKeyDescription['s2k'] {
    const usage = packet[usageAt]!;
    if (usage === 0) return 'none';
    if (usage < 253) return 'other';
    // A v6 key adds a count octet before the cipher, and an S2K length octet after the AEAD algorithm.
    const at = usageAt + 1 + (v6 ? 1 : 0) + 1 + (usage === 253 ? 1 : 0) + (v6 ? 1 : 0);
    const type = packet[at]!;
    if (type === S2K_TYPE_ARGON2) return 'argon2';
    return type === S2K_TYPE_ITERATED ? 'iterated' : 'other';
}
