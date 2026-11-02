import { expose, transferHandlers } from 'comlink';

import '@protontech/crypto/polyfill';
import { Api } from '@protontech/crypto/proxy/endpoint/api.ts';
import { workerTransferHandlers } from '@protontech/crypto/proxy/endpoint/workerPool/transferHandlers/index.ts';

// Exposes one `Api` instance directly: Bun cannot transfer the MessagePort that the
// stock pool's `new RemoteApi()` hands back, so `@protontech/crypto`'s own worker fails there.
for (const { name, handler } of workerTransferHandlers) {
    transferHandlers.set(name, handler);
}
Api.init({});
expose(new Api());
