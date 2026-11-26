/**
 * The node keys the Receive arm gives its files. A real Drive keeps each file's node key as an
 * armored OpenPGP private key; the SDK does not show it, yet it is the one thing that tells the
 * two kinds below apart. The fake Drive therefore holds the real thing, as fixtures:
 *
 * - `v4`: what every Proton client writes, and what the SDK's uploader writes
 *   (`dist/crypto/openPGPCrypto.js`): an `ed25519Legacy` v4 key locked with iterated S2K.
 * - `argon2`: what rclone 1.75.0 wrote for every file (Proton-API-Bridge v1.0.4, gopenpgp's
 *   `profile.RFC9580()`): a v6 key locked with Argon2 S2K and AEAD.
 *
 * Both were made with openpgp.js 6.3.1 and locked with the passphrase `fixture-passphrase`;
 * `node-keys.test.ts` reads them back to hold them to this description. Every file of a kind
 * shares its key. Only a Drive with real crypto (real-crypto.ts) unlocks one, once per file.
 */

/** The node key a file holds. A file with none given holds a `v4` key. */
export type NodeKeyKind = 'v4' | 'argon2';

const V4_KEY = [
    '-----BEGIN PGP PRIVATE KEY BLOCK-----',
    '',
    'xYYEaunggBYJKwYBBAHaRw8BAQdA5FUqwykMoaBIPglRPEPIKDuJ0R65FiTv',
    'u9rHWQUT/9j+CQMILUKc4KfJtmvgSMEGcMsZ6f01pMhzNUDQruN5yuTNFy+N',
    'HpGWwtWkUS3lSNeKD3tJZ4iZQsHQ+dp4ES+rHjF5zzxcuXmTS/8kAil/P8pW',
    'IM0JRHJpdmUga2V5wsARBBMWCgCDBYJq6eCAAwsJBwkQMOKlSNMKPktFFAAA',
    'AAAAHAAgc2FsdEBub3RhdGlvbnMub3BlbnBncGpzLm9yZ6nShVndWYQNgvLV',
    'raNPveGdVOSl2F9jfThI2otB2fRBAxUKCAQWAAIBAhkBApsDAh4BFiEENjIe',
    'XqHT3iIL4OZIMOKlSNMKPksAABf4AP4olrdf0T6/zGQSqtMRANSmngU9YC9L',
    '3qX7uC3/uYLQdgD/Uxv/IcEjA0A/sw2wo5u4qhmE5WjvIzM1q1qE4+YSxgfH',
    'iwRq6eCAEgorBgEEAZdVAQUBAQdAOoHVMkRPFveeykfqEMBn5o6OYxRE+g9y',
    '/tis2lmPHTUDAQgH/gkDCNSxMS9wx9gG4Nr+1w3sOSVvRsU5ThUM9YXARn6J',
    'LIEdEePtoXnYVEkEJdXMSCh1Z0tAxs18X64QXWiDCfIfugp4cc59xFGwxmS3',
    'DiO8bMTCvgQYFgoAcAWCaunggAkQMOKlSNMKPktFFAAAAAAAHAAgc2FsdEBu',
    'b3RhdGlvbnMub3BlbnBncGpzLm9yZ4BlJYImlVQMXnoFh/vsdI1VcxrR9BrW',
    'SDoPXBupPtjlApsMFiEENjIeXqHT3iIL4OZIMOKlSNMKPksAAID/AQD9wuWQ',
    'kQ/4tWt993vDXt+kpsYnKzqeXuQXIvVYUMeeGwEAtQSxDT8djzd3x+r7R06L',
    'oISs9yzkRsRGC7YPFemN/wE=',
    '=nQyb',
    '-----END PGP PRIVATE KEY BLOCK-----',
].join('\n');

const ARGON2_KEY = [
    '-----BEGIN PGP PRIVATE KEY BLOCK-----',
    '',
    'xX8GaungfxsAAAAgqPLa8ajaY+bO5CLUFjK91zNs2n8fnmuKf8ZS8dnmtWX9',
    'IwkDFARc/wRB4ipiRJa4ItZIPKNlAwQQRr/HCelDV/AO0ZJDosCkOQ5Oq+Zt',
    'wbUjQnofP0CVK8u06MwHgHYksPC1LxgsIorvMOvCL+4TbrUYS82Uwq0GHxsK',
    'AAAAPgWCaungfwMLCQcFFQoIDgwEFgACAQKbAwIeASKhBt7K36urlPmg/9gQ',
    'qQtbrdrf5kyH0P7AmVQQBmT1/zWXAAAAADIXIL/AfYuYMv2trV/qvtN/Gi42',
    '1y32pcBJ7gUVt5qcmAW46iJFszI2QFhw2lDu218aR1CYmwoi4qvASM/xVBaU',
    'EM/vHGfoTo29vkNWofMC6eWfUBsdMwAHOwWjBIg5GwnuD80JRHJpdmUga2V5',
    'wpsGExsKAAAALAWCaungfwIZASKhBt7K36urlPmg/9gQqQtbrdrf5kyH0P7A',
    'mVQQBmT1/zWXAAAAAFJ/IOXl667X2GFtZEFzD9/FTSR8dyNnVE25n7T9PGaS',
    'dRpiQuXfjkq3znECUCHdJzs7dNZemuhMm5mNOQ7+l7koN6zOEHxAMA0RwR4O',
    'Sg9gZqf1XKbnNqbhU57q3C46aN70Bsd/Bmrp4H8ZAAAAIJVh/B8qtW45kbdF',
    'PjE1ch8OjPGggz30ryS0Kq4C/YQx/SMJAxQEjPkeoLnHsOQrEIV4fHv4IQME',
    'EC9lKWJywi5ky3rID0q7kNi14D00nMZ89MgrQZ3UwwwXvYEMqzxT32eAjNEv',
    'DbT9FkoxRSadsuroGcXacMKbBhgbCgAAACwFgmrp4H8CmwwioQbeyt+rq5T5',
    'oP/YEKkLW63a3+ZMh9D+wJlUEAZk9f81lwAAAABtgiApJaaHXMFTy61W4+hG',
    '6yhsyL3KyGyY9E/bFkyRhiFP+mY/FxXPyw3RhMJFF0pn53+SC8Ios8sB2AVc',
    'GEnngCOdhhwrLJdBXd/JuflNedELZGosHGIl+iLq5+pgPo3fDQ4=',
    '-----END PGP PRIVATE KEY BLOCK-----',
].join('\n');

export function armoredNodeKey(kind: NodeKeyKind = 'v4'): string {
    return kind === 'argon2' ? ARGON2_KEY : V4_KEY;
}

/**
 * The version (4 or 6) of the OpenPGP key an armored private key holds, read from the version
 * octet of its first packet, where the SDK's key import reads it.
 */
export function nodeKeyVersion(armoredKey: string): number {
    const body = armoredKey
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('-----') && !line.startsWith('=') && !line.includes(':'))
        .join('');
    const packet = Uint8Array.from(atob(body.slice(0, 48)), (c) => c.charCodeAt(0));
    const header = packet[0]!;
    if ((header & 0x80) === 0) throw new Error('fake-drive: the node key does not start with an OpenPGP packet');
    let lengthOctets: number;
    if (header & 0x40) {
        // A new-format packet: a length of one, two or five octets.
        const first = packet[1]!;
        lengthOctets = first < 192 ? 1 : first < 224 ? 2 : first === 255 ? 5 : 1;
    } else {
        // An old-format packet: the header's low two bits say how many octets of length follow.
        lengthOctets = [1, 2, 4, 0][header & 3]!;
    }
    return packet[1 + lengthOctets]!;
}
