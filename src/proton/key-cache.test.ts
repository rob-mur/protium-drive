import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KEY_CACHE_FILE_NAME, removeKeyCache, UnlockedKeyCache } from './key-cache';
import { KEYRING_ITEM, type Keyring } from './keyring';

function stateDir(): string {
    return mkdtempSync(path.join(tmpdir(), 'pdm-key-cache-'));
}

function logs() {
    const lines: { level: string; message: string }[] = [];
    const at = (level: string) => (message: string) => lines.push({ level, message });
    return { lines, logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } };
}

/** A keyring in memory, as a desktop's Secret Service would be. */
function memoryKeyring(): Keyring & { value: string | null } {
    return {
        value: null,
        async get() {
            return this.value;
        },
        async set(value: string) {
            this.value = value;
        },
        async delete() {
            const had = this.value !== null;
            this.value = null;
            return had;
        },
    };
}

/** A keyring that cannot be reached, as on a headless host with no Secret Service. */
const unreachableKeyring: Keyring = {
    get: () => Promise.reject(new Error('libsecret not available')),
    set: () => Promise.reject(new Error('libsecret not available')),
    delete: () => Promise.reject(new Error('libsecret not available')),
};

const LOCKED = { armoredKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlocked\n', passphrase: 'node passphrase' };
const UNLOCKED = new Uint8Array([1, 2, 3, 4, 5]);

describe('the unlocked-key cache with a keyring', () => {
    test('keeps an unlocked key across a restart', async () => {
        const dir = stateDir();
        const keyring = memoryKeyring();
        const first = await UnlockedKeyCache.open({ stateDir: dir, keyring, logger: logs().logger });
        await first.set(LOCKED, UNLOCKED);
        await first.save();

        const second = await UnlockedKeyCache.open({ stateDir: dir, keyring, logger: logs().logger });

        expect(await second.get(LOCKED)).toEqual(UNLOCKED);
        expect(await second.get({ ...LOCKED, passphrase: 'another passphrase' })).toBeUndefined();
    });

    test('keeps the key in the keyring and never writes key material in the clear', async () => {
        const dir = stateDir();
        const keyring = memoryKeyring();
        const cache = await UnlockedKeyCache.open({ stateDir: dir, keyring, logger: logs().logger });
        const unlocked = new TextEncoder().encode('UNLOCKED-SECRET-MATERIAL');
        await cache.set(LOCKED, unlocked);
        await cache.save();

        const file = path.join(dir, KEY_CACHE_FILE_NAME);
        const text = readFileSync(file, 'utf8');
        expect(keyring.value).not.toBeNull();
        expect(text).not.toContain('UNLOCKED-SECRET-MATERIAL');
        expect(text).not.toContain(Buffer.from(unlocked).toString('base64'));
        expect(text).not.toContain('node passphrase');
        expect(text).not.toContain(keyring.value!);
        expect(JSON.parse(text).version).toBe(1);
        expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    test('holds at most its capacity, dropping the key used least recently', async () => {
        const cache = await UnlockedKeyCache.open({ stateDir: stateDir(), keyring: memoryKeyring(), logger: logs().logger, capacity: 2 });
        const locked = (n: number) => ({ armoredKey: `key ${n}`, passphrase: 'p' });
        await cache.set(locked(1), new Uint8Array([1]));
        await cache.set(locked(2), new Uint8Array([2]));
        await cache.get(locked(1));
        await cache.set(locked(3), new Uint8Array([3]));

        expect(await cache.get(locked(1))).toEqual(new Uint8Array([1]));
        expect(await cache.get(locked(2))).toBeUndefined();
        expect(await cache.get(locked(3))).toEqual(new Uint8Array([3]));
    });

    test('changes its state only when a key is added, so a save writes only what changed', async () => {
        const cache = await UnlockedKeyCache.open({ stateDir: stateDir(), keyring: memoryKeyring(), logger: logs().logger });
        const before = cache.state();
        await cache.get(LOCKED);
        expect(cache.state()).toBe(before);
        await cache.set(LOCKED, UNLOCKED);
        expect(cache.state()).not.toBe(before);
    });

    test('deletes a file it cannot decrypt and starts empty, with one warning', async () => {
        const dir = stateDir();
        const first = await UnlockedKeyCache.open({ stateDir: dir, keyring: memoryKeyring(), logger: logs().logger });
        await first.set(LOCKED, UNLOCKED);
        await first.save();

        // Another keyring key, as after the keyring was reset.
        const { lines, logger } = logs();
        const second = await UnlockedKeyCache.open({ stateDir: dir, keyring: memoryKeyring(), logger });

        expect(await second.get(LOCKED)).toBeUndefined();
        expect(existsSync(path.join(dir, KEY_CACHE_FILE_NAME))).toBe(false);
        expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1);
    });

    test('ignores a file of another version, and replaces it at the next save', async () => {
        const dir = stateDir();
        const file = path.join(dir, KEY_CACHE_FILE_NAME);
        writeFileSync(file, JSON.stringify({ version: 2, entries: { a: 'b' } }));
        const keyring = memoryKeyring();

        const cache = await UnlockedKeyCache.open({ stateDir: dir, keyring, logger: logs().logger });
        await cache.set(LOCKED, UNLOCKED);
        await cache.save();

        expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
        const reopened = await UnlockedKeyCache.open({ stateDir: dir, keyring, logger: logs().logger });
        expect(await reopened.get(LOCKED)).toEqual(UNLOCKED);
    });

    test('an entry moved to another key’s index does not decrypt there', async () => {
        const dir = stateDir();
        const keyring = memoryKeyring();
        const cache = await UnlockedKeyCache.open({ stateDir: dir, keyring, logger: logs().logger });
        const other = { armoredKey: 'other key', passphrase: 'p' };
        await cache.set(LOCKED, UNLOCKED);
        await cache.set(other, new Uint8Array([9]));
        await cache.save();
        const file = path.join(dir, KEY_CACHE_FILE_NAME);
        const stored = JSON.parse(readFileSync(file, 'utf8'));
        const [first, second] = Object.keys(stored.entries);
        [stored.entries[first], stored.entries[second]] = [stored.entries[second], stored.entries[first]];
        writeFileSync(file, JSON.stringify(stored));

        const reopened = await UnlockedKeyCache.open({ stateDir: dir, keyring, logger: logs().logger });

        expect(await reopened.get(LOCKED)).toBeUndefined();
        expect(await reopened.get(other)).toBeUndefined();
    });
});

describe('the unlocked-key cache without a keyring', () => {
    test('keeps keys in memory only, writes no file and does not fail', async () => {
        const dir = stateDir();
        const { lines, logger } = logs();
        const cache = await UnlockedKeyCache.open({ stateDir: dir, keyring: unreachableKeyring, logger });
        await cache.set(LOCKED, UNLOCKED);
        await cache.save();

        expect(await cache.get(LOCKED)).toEqual(UNLOCKED);
        expect(existsSync(path.join(dir, KEY_CACHE_FILE_NAME))).toBe(false);
        expect(lines.some((line) => line.level === 'info' && line.message.includes('keyring'))).toBe(true);
        expect(lines.filter((line) => line.level === 'warn' || line.level === 'error')).toEqual([]);

        const afterRestart = await UnlockedKeyCache.open({ stateDir: dir, keyring: unreachableKeyring, logger });
        expect(await afterRestart.get(LOCKED)).toBeUndefined();
    });

    test('leaves a file an earlier run saved untouched, for when the keyring is back', async () => {
        const dir = stateDir();
        const keyring = memoryKeyring();
        const first = await UnlockedKeyCache.open({ stateDir: dir, keyring, logger: logs().logger });
        await first.set(LOCKED, UNLOCKED);
        await first.save();
        const saved = readFileSync(path.join(dir, KEY_CACHE_FILE_NAME), 'utf8');

        const offline = await UnlockedKeyCache.open({ stateDir: dir, keyring: unreachableKeyring, logger: logs().logger });
        await offline.set({ armoredKey: 'other', passphrase: 'p' }, new Uint8Array([7]));
        await offline.save();

        expect(readFileSync(path.join(dir, KEY_CACHE_FILE_NAME), 'utf8')).toBe(saved);
        const back = await UnlockedKeyCache.open({ stateDir: dir, keyring, logger: logs().logger });
        expect(await back.get(LOCKED)).toEqual(UNLOCKED);
    });

    test('falls back when the keyring does not answer in time', async () => {
        const hanging: Keyring = { get: () => new Promise(() => {}), set: () => new Promise(() => {}), delete: () => new Promise(() => {}) };
        const cache = await UnlockedKeyCache.open({ stateDir: stateDir(), keyring: hanging, logger: logs().logger, keyringTimeoutMs: 20 });
        await cache.set(LOCKED, UNLOCKED);
        expect(await cache.get(LOCKED)).toEqual(UNLOCKED);
    });
});

describe('removing the unlocked-key cache', () => {
    test('deletes the file and the keyring item', async () => {
        const dir = stateDir();
        const keyring = memoryKeyring();
        const cache = await UnlockedKeyCache.open({ stateDir: dir, keyring, logger: logs().logger });
        await cache.set(LOCKED, UNLOCKED);
        await cache.save();

        await removeKeyCache(dir, keyring);

        expect(existsSync(path.join(dir, KEY_CACHE_FILE_NAME))).toBe(false);
        expect(keyring.value).toBeNull();
    });

    test('leaves the keyring item, which other state dirs share, when this one saved no cache', async () => {
        const keyring = memoryKeyring();
        keyring.value = 'another state dir’s secret';

        await removeKeyCache(stateDir(), keyring);

        expect(keyring.value).toBe('another state dir’s secret');
    });

    test('deletes the file even when the keyring cannot be reached', async () => {
        const dir = stateDir();
        writeFileSync(path.join(dir, KEY_CACHE_FILE_NAME), '{}');
        await removeKeyCache(dir, unreachableKeyring);
        expect(existsSync(path.join(dir, KEY_CACHE_FILE_NAME))).toBe(false);
    });
});

test('the keyring item is the one the captain chose', () => {
    expect(KEYRING_ITEM).toEqual({ service: 'proton-drive-mount', name: 'key-cache' });
});
