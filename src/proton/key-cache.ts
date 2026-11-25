import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../../vendor/proton-drive-sdk-account';
import { KEYRING_TIMEOUT_MS, withinTime, type Keyring } from './keyring';

export const KEY_CACHE_FILE_NAME = 'key-cache.json';
const FORMAT_VERSION = 1;

/** How many unlocked keys the cache holds, in memory and on disk. One is a few hundred bytes. */
export const KEY_CACHE_CAPACITY = 50_000;

const SECRET_BYTES = 32;
const IV_BYTES = 12;

/** A locked private key and its passphrase, as the crypto module is asked to unlock them. */
export type LockedKey = { armoredKey?: string; binaryKey?: Uint8Array; passphrase: string };

type StoredCache = { version: typeof FORMAT_VERSION; entries: Record<string, string> };

/** The two keys derived from the keyring secret: one names entries, one encrypts them. */
type Keys = { index: CryptoKey; seal: CryptoKey };

export type OpenOptions = {
    stateDir: string;
    keyring: Keyring;
    logger: Logger;
    capacity?: number;
    keyringTimeoutMs?: number;
};

/**
 * Unlocked node keys, by the locked key and passphrase they came from, so an Argon2 unlock runs
 * once per key rather than once per run.
 *
 * With the system keyring in reach, the cache lives on in `key-cache.json` in the state dir.
 * Every entry is encrypted with AES-256-GCM under a key derived from a secret the keyring holds,
 * and is named by an HMAC under another, so the file shows neither a key nor which key it is for.
 * Without the keyring the cache lives in memory only, under a secret of this run, and the file is
 * neither read nor written: the next run unlocks every key again, as before the cache existed.
 */
export class UnlockedKeyCache {
    /** Sealed entries by index, least recently used first. */
    private readonly entries: Map<string, string>;
    private changes = 0;

    private constructor(
        private readonly keys: Keys,
        private readonly file: KeyCacheFile | undefined,
        entries: Map<string, string>,
        private readonly capacity: number,
        private readonly logger: Logger,
    ) {
        this.entries = entries;
    }

    static async open(options: OpenOptions): Promise<UnlockedKeyCache> {
        const { stateDir, keyring, logger } = options;
        const capacity = options.capacity ?? KEY_CACHE_CAPACITY;
        const secret = await keyringSecret(keyring, options.keyringTimeoutMs ?? KEYRING_TIMEOUT_MS);
        if (secret instanceof Error) {
            logger.info(`The system keyring is out of reach (${secret.message}), so unlocked keys stay in memory only and unlock again after a restart`);
            return new UnlockedKeyCache(await deriveKeys(crypto.getRandomValues(new Uint8Array(SECRET_BYTES))), undefined, new Map(), capacity, logger);
        }
        const keys = await deriveKeys(secret);
        const file = new KeyCacheFile(stateDir);
        const cache = new UnlockedKeyCache(keys, file, await file.read(), capacity, logger);
        await cache.checkReadable();
        return cache;
    }

    /** The unlocked key for this locked key and passphrase, when the cache has it. */
    async get(locked: LockedKey): Promise<Uint8Array | undefined> {
        const index = await this.indexOf(locked);
        const sealed = this.entries.get(index);
        if (sealed === undefined) {
            return undefined;
        }
        this.entries.delete(index);
        this.entries.set(index, sealed);
        try {
            return await this.open(index, sealed);
        } catch {
            await this.discard();
            return undefined;
        }
    }

    async set(locked: LockedKey, unlocked: Uint8Array): Promise<void> {
        const index = await this.indexOf(locked);
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encode(index) }, this.keys.seal, new Uint8Array(unlocked));
        this.entries.delete(index);
        this.entries.set(index, Buffer.concat([iv, new Uint8Array(ciphertext)]).toString('base64'));
        for (const oldest of this.entries.keys()) {
            if (this.entries.size <= this.capacity) break;
            this.entries.delete(oldest);
        }
        this.changes++;
    }

    /** A value that changes whenever a save would write something new. */
    state(): string {
        return String(this.changes);
    }

    /** Writes the cache to its file; does nothing when the keyring is out of reach. Throws when the file cannot be written. */
    async save(): Promise<void> {
        await this.file?.write({ version: FORMAT_VERSION, entries: Object.fromEntries(this.entries) });
    }

    /** Drops a saved cache this keyring secret cannot open, as after the keyring was reset: tested on one entry. */
    private async checkReadable(): Promise<void> {
        const first = this.entries.entries().next();
        if (first.done) {
            return;
        }
        try {
            await this.open(...first.value);
        } catch {
            await this.discard();
        }
    }

    private async discard(): Promise<void> {
        this.entries.clear();
        this.changes++;
        await this.file?.remove();
        this.logger.warn(`Could not decrypt the saved unlocked keys in ${this.file?.filePath}, so pdm deleted them; keys unlock again from Proton`);
    }

    private async open(index: string, sealed: string): Promise<Uint8Array> {
        const bytes = Buffer.from(sealed, 'base64');
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES), additionalData: encode(index) },
            this.keys.seal,
            bytes.subarray(IV_BYTES),
        );
        return new Uint8Array(plain);
    }

    private async indexOf({ armoredKey, binaryKey, passphrase }: LockedKey): Promise<string> {
        const key = binaryKey ?? encode(armoredKey ?? '');
        // The passphrase's length goes first, so no passphrase and key pair reads as another.
        const passphraseBytes = encode(passphrase);
        const length = new Uint8Array(4);
        new DataView(length.buffer).setUint32(0, passphraseBytes.length);
        const mac = await crypto.subtle.sign('HMAC', this.keys.index, Buffer.concat([length, passphraseBytes, key]));
        return Buffer.from(mac).toString('hex');
    }
}

/**
 * Deletes the saved cache and the keyring secret, as signing out does. The file goes even when
 * the keyring is out of reach. Every state dir shares the one keyring item, so it goes only when
 * this state dir had saved a cache: signing out of a state dir that never did leaves the others'.
 */
export async function removeKeyCache(stateDir: string, keyring: Keyring, keyringTimeoutMs = KEYRING_TIMEOUT_MS): Promise<void> {
    const file = new KeyCacheFile(stateDir);
    const saved = await Bun.file(file.filePath).exists();
    await file.remove();
    if (saved) {
        await withinTime(() => keyring.delete(), keyringTimeoutMs).catch(() => false);
    }
}

/** The keyring's secret, made and stored on first use; the error when the keyring is out of reach. */
async function keyringSecret(keyring: Keyring, timeoutMs: number): Promise<Uint8Array<ArrayBuffer> | Error> {
    try {
        const stored = await withinTime(() => keyring.get(), timeoutMs);
        if (stored !== null) {
            const secret = Buffer.from(stored, 'base64');
            if (secret.length === SECRET_BYTES) {
                return new Uint8Array(secret);
            }
        }
        const secret = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
        await withinTime(() => keyring.set(Buffer.from(secret).toString('base64')), timeoutMs);
        return secret;
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
}

async function deriveKeys(secret: Uint8Array<ArrayBuffer>): Promise<Keys> {
    const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const derive = (info: string, algorithm: HmacImportParams | AesKeyGenParams, usages: KeyUsage[]) =>
        crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encode(info) }, base, algorithm, false, usages);
    // Old name kept on purpose after the rename to protium-drive (#143): live installs hold state under it.
    return {
        index: await derive('proton-drive-mount key-cache index', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
        seal: await derive('proton-drive-mount key-cache entry', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    };
}

function encode(text: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(text);
}

/**
 * `key-cache.json`: the sealed entries, mode 0600 in the 0700 state dir. A file this version
 * cannot read is ignored, and the next save replaces it.
 */
class KeyCacheFile {
    readonly filePath: string;

    constructor(private readonly stateDir: string) {
        this.filePath = path.join(stateDir, KEY_CACHE_FILE_NAME);
    }

    async read(): Promise<Map<string, string>> {
        let stored: Partial<StoredCache>;
        try {
            stored = JSON.parse(await Bun.file(this.filePath).text()) as Partial<StoredCache>;
        } catch {
            return new Map();
        }
        if (stored?.version !== FORMAT_VERSION || typeof stored.entries !== 'object' || stored.entries === null) {
            return new Map();
        }
        const entries = Object.entries(stored.entries);
        return entries.every(([, sealed]) => typeof sealed === 'string') ? new Map(entries) : new Map();
    }

    /** Replaces the file whole, so a crash mid-write leaves the old cache or the new one, never half. */
    async write(stored: StoredCache): Promise<void> {
        await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
        await chmod(this.stateDir, 0o700);
        const tmpPath = `${this.filePath}.${process.pid}.tmp`;
        try {
            await Bun.write(tmpPath, JSON.stringify(stored), { mode: 0o600 });
            await chmod(tmpPath, 0o600);
            await rename(tmpPath, this.filePath);
        } catch (error) {
            await rm(tmpPath, { force: true }).catch(() => {});
            throw error;
        }
    }

    /** Deletes the file, and any temporary file a save that died midway left. */
    async remove(): Promise<void> {
        await rm(this.filePath, { force: true });
        let names: string[];
        try {
            names = await readdir(this.stateDir);
        } catch {
            return;
        }
        const leftover = (name: string) => name.startsWith(`${KEY_CACHE_FILE_NAME}.`) && name.endsWith('.tmp');
        for (const name of names.filter(leftover)) {
            await rm(path.join(this.stateDir, name), { force: true });
        }
    }
}
