import { CryptoProxy } from '@protontech/crypto';
import type { Api } from '@protontech/crypto/proxy/endpoint/api.ts';
import { mainThreadTransferHandlers } from '@protontech/crypto/proxy/endpoint/workerPool/transferHandlers/index.ts';
import { transferHandlers, wrap, releaseProxy, type Remote } from 'comlink';
import { readPrivateKey } from 'openpgp';

type Lane = { worker: Worker; api: Remote<Api> };

let lanes: { main: Lane; unlock: Lane } | undefined;

/**
 * Routes `CryptoProxy` to two crypto workers, once.
 *
 * Unlocking a node key that rclone 1.75.0 locked with Argon2 costs two 64 MiB runs and about
 * 0.4 s of CPU, which in-process would stall every request. A walk of the mount unlocks one key
 * per node it loads for the first time, so those unlocks get a worker of their own: the unlock
 * worker takes them one at a time, so memory stays at one unlock's 128 MiB however many files a
 * listing touches. The main worker does all other crypto, so new keys, encryption and cheap
 * unlocks never wait behind a walk. The unlock worker hands each unlocked key to the main worker
 * over the worker message channel and forgets it; unlocked keys live only in the workers' memory,
 * never on disk.
 */
export function initCryptoWorker(): void {
    if (lanes !== undefined) {
        return;
    }
    for (const { name, handler } of mainThreadTransferHandlers) {
        transferHandlers.set(name, handler);
    }
    lanes = { main: startLane(), unlock: startLane() };
    const { main, unlock } = lanes;
    // One unlock at a time, start to finish: queued in the worker instead, every export would wait
    // behind every queued unlock, and a listing would get none of its keys until it had them all.
    let unlocking: Promise<unknown> = Promise.resolve();
    const importPrivateKey: Api['importPrivateKey'] = async (options) => {
        if (options.passphrase === null || !(await isArgon2Locked(options))) {
            return main.api.importPrivateKey(options);
        }
        const unlocked = unlocking.then(() => unlockAndExport(unlock.api, options));
        unlocking = unlocked.catch(() => undefined);
        return main.api.importPrivateKey({ binaryKey: await unlocked, passphrase: null });
    };
    const endpoint = new Proxy(main.api, {
        get: (target, property, receiver) => (property === 'importPrivateKey' ? importPrivateKey : Reflect.get(target, property, receiver)),
    });
    CryptoProxy.setEndpoint(endpoint as unknown as Api, (remote) => remote.clearKeyStore());
}

function startLane(): Lane {
    const worker = new Worker(workerEntry(), { type: 'module' });
    return { worker, api: wrap<Api>(worker) };
}

/** Whether unlocking the key runs Argon2: any of its key packets is locked with Argon2 S2K. */
async function isArgon2Locked({ armoredKey, binaryKey }: Parameters<Api['importPrivateKey']>[0]): Promise<boolean> {
    const key = binaryKey ? await readPrivateKey({ binaryKey }) : await readPrivateKey({ armoredKey: armoredKey as string });
    return key.getKeys().some(({ keyPacket }) => (keyPacket as { s2k?: { type?: string } }).s2k?.type === 'argon2');
}

/** Unlocks the key on the unlock worker and returns it unlocked, leaving no copy there. */
async function unlockAndExport(unlock: Remote<Api>, options: Parameters<Api['importPrivateKey']>[0]): Promise<Uint8Array<ArrayBuffer>> {
    const key = await unlock.importPrivateKey(options);
    try {
        return (await unlock.exportPrivateKey({ privateKey: key, passphrase: null, format: 'binary' })) as Uint8Array<ArrayBuffer>;
    } finally {
        await unlock.clearKey({ key });
    }
}

/**
 * In the compiled binary a worker is found by its path under the embedded root, where `build`
 * lists it as a second entry point; from source it sits beside this file.
 */
function workerEntry(): string | URL {
    return Bun.main.startsWith('/$bunfs/') ? './proton/crypto-worker.ts' : new URL('./crypto-worker.ts', import.meta.url);
}

/** Ends the workers; the next `initCryptoWorker` starts fresh ones. */
export async function stopCryptoWorker(): Promise<void> {
    if (lanes === undefined) {
        return;
    }
    await CryptoProxy.releaseEndpoint();
    for (const { worker, api } of [lanes.main, lanes.unlock]) {
        api[releaseProxy]();
        worker.terminate();
    }
    lanes = undefined;
}
