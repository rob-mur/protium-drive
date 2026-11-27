import { expect, test } from 'bun:test';

import { FileDownloader } from '@protontech/drive-sdk/dist/internal/download/fileDownloader.js';

/**
 * A range read opens several seekable streams on one downloader to read ahead (src/drive/download.ts).
 * Each stream frees the SDK download slot when the download's signal aborts, so unpatched, one
 * downloader would free its one slot once per stream and let more downloads run than the SDK allows.
 * patches/@protontech%2Fdrive-sdk@0.23.0.patch frees it once per downloader.
 */
test('the patched SDK frees a download slot once, however many seekable streams the downloader opened', () => {
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    const abort = new AbortController();
    let freed = 0;
    const downloader = new FileDownloader(
        { getLoggerForRevision: () => quiet } as never,
        {} as never,
        { getRevisionKeys: async () => ({}) } as never,
        {} as never,
        { uid: 'revision-1', claimedBlockSizes: [4] } as never,
        abort.signal,
        () => freed++,
    );

    for (let i = 0; i < 4; i++) downloader.getSeekableStream();
    abort.abort();

    expect(freed).toBe(1);
});
