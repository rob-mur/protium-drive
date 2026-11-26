/**
 * The SDK's own crypto, for a Drive that asks for it (`DriveState.realCrypto`): the Receive arm
 * then does the crypto work the SDK would do, through the product's crypto pool
 * (`src/proton/crypto-pool.ts`), so a test sees what that work costs the product.
 *
 * - Loading a file's node unlocks its node key (`CryptoProxy.importPrivateKey`), as the SDK's
 *   `nodesAccess` does, once per node: the key stays for later downloads, as the SDK caches it. An
 *   `argon2` key (node-keys.ts) costs an Argon2 unlock, as a node rclone 1.75.0 wrote does.
 * - A listing loads up to `DECRYPTION_CONCURRENCY` nodes at once, as the SDK's `iterateNodes` does.
 * - A download decrypts the file's content with that key (`CryptoProxy.decryptMessage`), as the
 *   SDK decrypts each block. The fake Drive keeps content in clear text, so the download first
 *   encrypts it to the same key, which stands in for the Drive sending it encrypted.
 *
 * Nothing here reaches Proton. With no `realCrypto`, the Receive arm does no crypto at all.
 */
import { CryptoProxy, type PrivateKeyReference } from '@protontech/crypto';

import { initCryptoWorker, stopCryptoWorker } from '../src/proton/crypto-pool.ts';

/** The passphrase that locks every node key fixture (node-keys.ts). */
export const NODE_KEY_PASSPHRASE = 'fixture-passphrase';

/** How many nodes the SDK decrypts at once in `iterateNodes` (`nodesAccess.js`, `DECRYPTION_CONCURRENCY`). */
export const DECRYPTION_CONCURRENCY = 30;

export class RealCrypto {
    private started = false;
    /** Each node's unlocked key, by node UID. */
    private readonly keys = new Map<string, Promise<PrivateKeyReference>>();

    /** The unlocked node key of the file `uid`, which holds `armoredKey`: unlocked on first use, then kept. */
    nodeKey(uid: string, armoredKey: string): Promise<PrivateKeyReference> {
        const known = this.keys.get(uid);
        if (known) return known;
        this.start();
        const key = CryptoProxy.importPrivateKey({ armoredKey, passphrase: NODE_KEY_PASSPHRASE });
        this.keys.set(uid, key);
        // A failed unlock is tried again on the next load, as the SDK caches no failure.
        key.catch(() => this.keys.delete(uid));
        return key;
    }

    /** `content`, encrypted to `key` and then decrypted with it, as a download receives and decrypts it. */
    async download(key: PrivateKeyReference, content: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
        this.start();
        const { message } = await CryptoProxy.encryptMessage({ binaryData: content, encryptionKeys: key, format: 'binary' });
        const { data } = await CryptoProxy.decryptMessage({ binaryMessage: message, decryptionKeys: key, format: 'binary' });
        return data as Uint8Array<ArrayBuffer>;
    }

    /** Ends the crypto workers, if this started them. */
    async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;
        this.keys.clear();
        await stopCryptoWorker();
    }

    private start(): void {
        if (this.started) return;
        this.started = true;
        initCryptoWorker();
    }
}

/**
 * Runs `fn` over `items`, at most `limit` at once, and yields each result as it ends, as the
 * SDK's `asyncIteratorMap` does.
 */
export async function* mapConcurrently<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): AsyncGenerator<R> {
    const running = new Map<number, Promise<{ index: number; result: R }>>();
    let next = 0;
    const launch = () => {
        const index = next++;
        const run = fn(items[index]!).then((result) => ({ index, result }));
        // A failure ends the iteration at the race below; one that comes after it must not go unhandled.
        run.catch(() => {});
        running.set(index, run);
    };
    while (next < items.length && running.size < limit) launch();
    while (running.size > 0) {
        const { index, result } = await Promise.race(running.values());
        running.delete(index);
        if (next < items.length) launch();
        yield result;
    }
}
