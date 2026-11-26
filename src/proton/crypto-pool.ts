import { AsyncLocalStorage } from 'node:async_hooks';

import { CryptoProxy } from '@protontech/crypto';
import type { Api } from '@protontech/crypto/proxy/endpoint/api.ts';
import { mainThreadTransferHandlers } from '@protontech/crypto/proxy/endpoint/workerPool/transferHandlers/index.ts';
import { transferHandlers, wrap, releaseProxy, type Remote } from 'comlink';
import { readPrivateKey } from 'openpgp';

import type { LockedKey } from './key-cache';

type Lane = { worker: Worker; api: Remote<Api> };

/** Where Argon2-unlocked keys are kept, so each one is unlocked once: see `UnlockedKeyCache`. */
export type UnlockedKeyStore = {
    get(locked: LockedKey): Promise<Uint8Array | undefined>;
    set(locked: LockedKey, unlocked: Uint8Array): Promise<void>;
};

let lanes: { main: Lane; unlock: Lane } | undefined;
let unlockedKeys: UnlockedKeyStore | undefined;
/** The client request the code running now serves: whether it reads a file, and when it came. */
type ClientRequest = { read: boolean; arrival: number };
const clientRequest = new AsyncLocalStorage<ClientRequest>();
let arrivals = 0;

/**
 * Runs `serve`, the work of one client request, so that its Argon2 unlocks go ahead of those of
 * every request that came before it, and a read's skip the unlock worker (#159).
 */
export function servingRequest<T>({ read }: { read: boolean }, serve: () => Promise<T>): Promise<T> {
    return clientRequest.run({ read, arrival: ++arrivals }, serve);
}

/**
 * Keeps each key the unlock worker unlocks in `store`, and takes a key from there rather than
 * unlocking it again; `undefined` stops that. A store that fails only costs the unlock it would
 * have saved.
 */
export function cacheUnlockedKeys(store: UnlockedKeyStore | undefined): void {
    unlockedKeys = store;
}

/**
 * Routes `CryptoProxy` to two crypto workers, once.
 *
 * Unlocking a node key that rclone 1.75.0 locked with Argon2 costs two 64 MiB runs and about
 * 0.4 s of CPU, which in-process would stall every request. A walk of the mount unlocks one key
 * per node it loads for the first time, so those unlocks get a worker of their own: the unlock
 * worker takes them one at a time, so memory stays at one unlock's 128 MiB however many files a
 * listing touches. The main worker does all other crypto, so new keys, encryption and cheap
 * unlocks never wait behind a walk. The unlock worker hands each unlocked key to the main worker
 * over the worker message channel and forgets it. With `cacheUnlockedKeys`, each unlocked key is
 * also kept, encrypted, in the unlocked-key cache, and a key found there skips the unlock worker.
 *
 * A walk can have hundreds of unlocks queued, which is minutes, so they do not go first come,
 * first served: each lane runs the unlocks of the newest client request (`servingRequest`) first,
 * and those of a request that came earlier, or of none, after. The listing a program's path
 * lookup asks for thus waits for one unlock of the walk's, not all of them. A read's unlocks run
 * on the main worker, one at a time, so they wait for no unlock of a walk's at all, and memory
 * stays at two unlocks.
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
    const unlockOn = { read: unlockQueue(main), other: unlockQueue(unlock) };
    const importPrivateKey: Api['importPrivateKey'] = async (options) => {
        if (options.passphrase === null || !(await isArgon2Locked(options))) {
            return main.api.importPrivateKey(options);
        }
        const locked = { armoredKey: options.armoredKey, binaryKey: options.binaryKey, passphrase: options.passphrase };
        const store = unlockedKeys;
        const cached = await store?.get(locked).catch(() => undefined);
        if (cached !== undefined) {
            try {
                return await main.api.importPrivateKey({ binaryKey: cached as Uint8Array<ArrayBuffer>, passphrase: null });
            } catch {
                // Unlock it again, below.
            }
        }
        const request = clientRequest.getStore();
        const binaryKey = await unlockOn[request?.read ? 'read' : 'other'](request?.arrival ?? 0, options);
        await store?.set(locked, binaryKey).catch(() => undefined);
        return main.api.importPrivateKey({ binaryKey, passphrase: null });
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

/**
 * Unlocks keys on `lane` one at a time, start to finish, the newest request's first and each
 * request's in the order they came. Queued in the worker instead, every export would wait behind
 * every queued unlock, and a listing would get none of its keys until it had them all.
 */
function unlockQueue(lane: Lane): (arrival: number, options: Parameters<Api['importPrivateKey']>[0]) => Promise<Uint8Array<ArrayBuffer>> {
    const waiting: { arrival: number; start: () => void }[] = [];
    let busy = false;
    const next = () => {
        const newest = waiting.reduce((best, job, index) => (job.arrival > waiting[best]!.arrival ? index : best), 0);
        const [job] = waiting.splice(newest, 1);
        busy = job !== undefined;
        job?.start();
    };
    return async (arrival, options) => {
        if (busy) await new Promise<void>((start) => waiting.push({ arrival, start }));
        busy = true;
        try {
            return await unlockAndExport(lane.api, options);
        } finally {
            next();
        }
    };
}

/** Whether unlocking the key runs Argon2: any of its key packets is locked with Argon2 S2K. */
async function isArgon2Locked({ armoredKey, binaryKey }: Parameters<Api['importPrivateKey']>[0]): Promise<boolean> {
    const key = binaryKey ? await readPrivateKey({ binaryKey }) : await readPrivateKey({ armoredKey: armoredKey as string });
    return key.getKeys().some(({ keyPacket }) => (keyPacket as { s2k?: { type?: string } }).s2k?.type === 'argon2');
}

/** Unlocks the key on `unlock`'s worker and returns it unlocked, leaving no copy there. */
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
