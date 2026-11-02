import { CryptoProxy } from '@protontech/crypto';
import type { Api } from '@protontech/crypto/proxy/endpoint/api.ts';
import { mainThreadTransferHandlers } from '@protontech/crypto/proxy/endpoint/workerPool/transferHandlers/index.ts';
import { transferHandlers, wrap, releaseProxy, type Remote } from 'comlink';

let worker: Worker | undefined;
let endpoint: Remote<Api> | undefined;

/**
 * Routes `CryptoProxy` to one crypto worker, once.
 *
 * Unlocking a node key that rclone 1.75.0 locked with Argon2 costs two 64 MiB runs and about
 * 0.4 s of CPU, which in-process would stall every request. One worker takes the unlocks
 * serially, so at most one runs at a time: memory stays at one unlock's 128 MiB however many
 * files a listing touches. Unlocked keys live only in the worker's memory, never on disk.
 */
export function initCryptoWorker(): void {
    if (worker !== undefined) {
        return;
    }
    for (const { name, handler } of mainThreadTransferHandlers) {
        transferHandlers.set(name, handler);
    }
    worker = new Worker(workerEntry(), { type: 'module' });
    endpoint = wrap<Api>(worker);
    CryptoProxy.setEndpoint(endpoint as unknown as Api, (remote) => remote.clearKeyStore());
}

/**
 * In the compiled binary a worker is found by its path under the embedded root, where `build`
 * lists it as a second entry point; from source it sits beside this file.
 */
function workerEntry(): string | URL {
    return Bun.main.startsWith('/$bunfs/') ? './proton/crypto-worker.ts' : new URL('./crypto-worker.ts', import.meta.url);
}

/** Ends the worker; the next `initCryptoWorker` starts a fresh one. */
export async function stopCryptoWorker(): Promise<void> {
    if (worker === undefined || endpoint === undefined) {
        return;
    }
    await CryptoProxy.releaseEndpoint();
    endpoint[releaseProxy]();
    worker.terminate();
    worker = undefined;
    endpoint = undefined;
}
