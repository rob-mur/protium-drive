import { AbortError, type FileDownloader, type Logger } from '@protontech/drive-sdk';

import type { Entry } from './entry';
import type { DriveSdk } from './sdk';

/** Inclusive byte range, as in an HTTP `Range` header. */
export type ByteRange = { start: number; end: number };

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

/** Bytes one range fetch asks for: Proton's block size, so that one fetch is one block. */
export const READ_AHEAD_CHUNK = 4 * 1024 * 1024;
/**
 * Range fetches out at once, the one the reader waits for included. A range read holds at most
 * this many chunks, so it buffers no more than `READ_AHEAD_DEPTH * READ_AHEAD_CHUNK` bytes.
 */
export const READ_AHEAD_DEPTH = 4;
/** Chunks the bridge holds before it makes the SDK wait. */
const BRIDGE_HIGH_WATER_MARK = 4;

export type DownloadOptions = {
    range?: ByteRange;
    /** The client's request signal. When it aborts, the download stops and frees its slot. */
    signal?: AbortSignal;
    logger: Logger;
    onError?: (error: unknown) => void;
};

/**
 * Opens a download as a byte stream, without buffering the whole file.
 *
 * Three SDK details shape this function:
 * - Each downloader holds one of the SDK's few download slots, from before the
 *   SDK loads the node's keys, so the node is loaded first. A seekable
 *   stream frees it when its signal aborts; `downloadToStream` frees it only
 *   when the download ends, so a writer that waits for a reader must be
 *   released when the reader goes away. Every path here aborts the signal and
 *   releases the writer when it ends, fails or the client goes away.
 * - `downloadToStream` never closes the stream it writes to; we close it.
 * - Bun turns a body that fails before its first byte into an empty "200 OK".
 *   So the returned promise resolves only after the first chunk exists, and an
 *   early failure rejects it, which the WebDAV layer sends as an HTTP error.
 *   Bun neither reads nor cancels the body of a response that it never sent,
 *   so a client that leaves before then must abort the download through
 *   `signal`.
 */
export async function openDownload(sdk: DriveSdk, file: Entry, options: DownloadOptions): Promise<ReadableStream<Uint8Array>> {
    const { range, signal, logger } = options;
    const onError = options.onError ?? (() => {});
    const abort = new AbortController();
    const abortDownload = () => abort.abort();
    if (signal?.aborted) {
        abortDownload();
    } else {
        signal?.addEventListener('abort', abortDownload, { once: true });
        abort.signal.addEventListener('abort', () => signal?.removeEventListener('abort', abortDownload), { once: true });
    }

    let downloader: FileDownloader;
    try {
        // The SDK takes a download slot before it loads the node's keys, so load them first: a
        // read that waits for an unlock then holds no slot that a read with its keys could use
        // (#163). A failure here is left to `getFileDownloader`, which reports it as before.
        await untilAborted(sdk.getNode(file.uid).catch(() => undefined), abort.signal);
        downloader = await sdk.getFileDownloader(file.uid, abort.signal);
    } catch (error: unknown) {
        abort.abort();
        onError(error);
        throw error;
    }

    const fullFile = !range || (range.start === 0 && range.end >= file.size - 1);
    let stream: ReadableStream<Uint8Array>;
    if (fullFile) {
        stream = streamWholeFile(downloader, abort, onError);
    } else {
        try {
            stream = await untilAborted(streamRange(downloader, range, abort, onError), signal);
        } catch (error: unknown) {
            if (abort.signal.aborted || signal?.aborted) {
                abort.abort();
                throw error;
            }
            // Old revisions have no block sizes, so the SDK cannot seek in them.
            // Download from the start and skip to the range instead.
            logger.info(`Seek not possible for ${file.uid} (${String(error)}); reading from the start`);
            stream = sliceStream(streamWholeFile(downloader, abort, onError), range.start, range.end);
        }
    }
    return primeStream(stream, abort, signal);
}

/**
 * Streams a whole file through `downloadToStream`. The last chunk is held back
 * until the SDK has checked the file's manifest signature, so a file that
 * fails the check never reaches the client complete.
 */
function streamWholeFile(
    downloader: FileDownloader,
    abort: AbortController,
    onError: (error: unknown) => void,
): ReadableStream<Uint8Array> {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let held: Uint8Array | undefined;
    let resumeWriter: (() => void) | undefined;
    let cancelled = false;

    const readable = new ReadableStream<Uint8Array>(
        {
            start(controller) {
                output = controller;
            },
            pull() {
                resumeWriter?.();
                resumeWriter = undefined;
            },
            cancel() {
                cancelled = true;
                resumeWriter?.();
                abort.abort();
            },
        },
        { highWaterMark: BRIDGE_HIGH_WATER_MARK },
    );

    // An abort must also release a writer that waits for the reader, or the
    // SDK download never ends and never frees its slot.
    abort.signal.addEventListener(
        'abort',
        () => {
            cancelled = true;
            resumeWriter?.();
            resumeWriter = undefined;
        },
        { once: true },
    );

    const writable = new WritableStream<Uint8Array>({
        async write(chunk) {
            if (cancelled) {
                throw new AbortError('Client closed the connection');
            }
            if (held) {
                output.enqueue(held);
            }
            held = chunk;
            if ((output.desiredSize ?? 1) <= 0) {
                await new Promise<void>((resolve) => {
                    resumeWriter = resolve;
                });
            }
        },
    });

    downloader
        .downloadToStream(writable)
        .completion()
        .then(
            () => {
                if (cancelled) {
                    return;
                }
                if (held) {
                    output.enqueue(held);
                }
                output.close();
            },
            (error: unknown) => {
                onError(error);
                if (!cancelled) {
                    output.error(error);
                }
            },
        )
        .finally(() => abort.abort());

    return readable;
}

type Seekable = ReturnType<FileDownloader['getSeekableStream']>;
type Chunk = { value: Uint8Array; short: boolean };

/**
 * Streams `range` with the SDK's seekable streams. Throws if the revision cannot seek.
 *
 * One seekable stream fetches one block at a time, so the range is cut into block-sized chunks
 * that `READ_AHEAD_DEPTH` seekable streams of the one downloader fetch at once. Chunk `n` goes to
 * stream `n % READ_AHEAD_DEPTH`, which by then has handed over chunk `n - READ_AHEAD_DEPTH`. A
 * new chunk starts only when the reader takes one, so a slow reader holds the fetches back, and
 * none starts past the end of the range. When the reader goes away or the range ends, the abort
 * stops the fetches still out.
 */
async function streamRange(
    downloader: FileDownloader,
    range: ByteRange,
    abort: AbortController,
    onError: (error: unknown) => void,
): Promise<ReadableStream<Uint8Array>> {
    const lanes: Seekable[] = [downloader.getSeekableStream()];
    let next = range.start;
    let started = 0;
    const inFlight: Promise<Chunk>[] = [];

    const fetchNext = () => {
        const start = next;
        const end = Math.min(range.end, (Math.floor(start / READ_AHEAD_CHUNK) + 1) * READ_AHEAD_CHUNK - 1);
        next = end + 1;
        const lane = started++ % READ_AHEAD_DEPTH;
        const chunk = (async () => {
            const seekable = (lanes[lane] ??= downloader.getSeekableStream());
            await seekable.seek(start);
            // The SDK's read gives every byte asked for unless the file ends first.
            const { value } = await seekable.read(end - start + 1);
            return { value, short: value.length < end - start + 1 };
        })();
        // A fetch the reader never reaches must not fail as an unhandled rejection.
        chunk.catch(() => {});
        inFlight.push(chunk);
    };

    return new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                try {
                    while (inFlight.length < READ_AHEAD_DEPTH && next <= range.end && !abort.signal.aborted) {
                        fetchNext();
                    }
                    const { value, short } = await inFlight.shift()!;
                    if (value.length > 0) {
                        controller.enqueue(value);
                    }
                    if (short || (inFlight.length === 0 && next > range.end)) {
                        controller.close();
                        abort.abort();
                    }
                } catch (error: unknown) {
                    onError(error);
                    abort.abort();
                    controller.error(error);
                }
            },
            cancel() {
                abort.abort();
            },
        },
        { highWaterMark: 0 },
    );
}

/** Drops bytes before `start` and after `end` (inclusive). */
export function sliceStream(source: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
    let position = 0;
    const reader = source.getReader();
    return new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        controller.close();
                        return;
                    }
                    const chunkStart = position;
                    position += value.length;
                    if (position <= start) {
                        continue;
                    }
                    const from = Math.max(0, start - chunkStart);
                    const to = Math.min(value.length, end + 1 - chunkStart);
                    if (to > from) {
                        controller.enqueue(value.subarray(from, to));
                    }
                    if (position > end) {
                        controller.close();
                        await reader.cancel();
                    }
                    return;
                }
            },
            cancel(reason) {
                return reader.cancel(reason);
            },
        },
        { highWaterMark: 0 },
    );
}

/**
 * Reads the first chunk before returning, then hands back a stream that
 * starts with it. Rejects if the stream fails before its first chunk, or if
 * `signal` (the client's request) aborts first.
 */
export async function primeStream(
    source: ReadableStream<Uint8Array>,
    abort?: AbortController,
    signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
    const reader = source.getReader();
    let first: ReadResult;
    try {
        first = await untilAborted(reader.read(), signal);
    } catch (error: unknown) {
        abort?.abort();
        reader.cancel(error).catch(() => {});
        throw error;
    }
    let pending: ReadResult | undefined = first;
    return new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                const result = pending ?? (await reader.read());
                pending = undefined;
                if (result.done) {
                    controller.close();
                } else {
                    controller.enqueue(result.value);
                }
            },
            cancel(reason) {
                abort?.abort();
                return reader.cancel(reason);
            },
        },
        { highWaterMark: 0 },
    );
}

/** Settles like `promise`, or rejects with an `AbortError` as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise;
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new AbortError('The client closed the connection'));
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}
