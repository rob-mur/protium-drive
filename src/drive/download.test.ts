import { describe, expect, test } from 'bun:test';
import { AbortError, type FileDownloader } from '@protontech/drive-sdk';

import type { Entry } from './entry.ts';
import { openDownload, primeStream, READ_AHEAD_CHUNK, READ_AHEAD_DEPTH, sliceStream } from './download.ts';
import type { DriveSdk } from './sdk.ts';

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

function fileEntry(size: number): Entry {
    return {
        uid: 'file-1',
        name: 'clip.mp4',
        kind: 'file',
        size,
        modified: new Date('2026-02-01T00:00:00Z'),
        created: new Date('2026-01-01T00:00:00Z'),
        revisionUid: 'rev-1',
        treeEventScopeId: 'volume-1',
    };
}

function bytes(n: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = i % 256;
    }
    return out;
}

/**
 * A fake `FileDownloader`: `downloadToStream` streams `content` through the
 * writable only while the download's abort signal is live, like the SDK's.
 */
function fakeDownloader(content: Uint8Array, observed: { aborted?: boolean } = {}): FileDownloader & { setSignal(signal: AbortSignal): void } {
    // The signal comes from `getFileDownloader`, so the fake learns it there.
    const abort = new AbortController();
    abort.signal.addEventListener('abort', () => {
        observed.aborted = true;
    });
    return {
        getClaimedSizeInBytes: () => content.length,
        downloadToStream(writable: WritableStream<Uint8Array>) {
            const signal = abort.signal;
            const completion = (async () => {
                const writer = writable.getWriter();
                const abortWrite = () => writer.abort(new AbortError('Client closed the connection'));
                if (signal.aborted) {
                    abortWrite();
                    return;
                }
                signal.addEventListener('abort', abortWrite, { once: true });
                const chunkSize = 1000;
                for (let start = 0; start < content.length; start += chunkSize) {
                    if (signal.aborted) {
                        return;
                    }
                    await writer.write(content.subarray(start, Math.min(start + chunkSize, content.length)));
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                signal.removeEventListener('abort', abortWrite);
                await writer.close();
            })();
            return {
                pause() {},
                resume() {},
                completion: () => completion,
                isDownloadCompleteWithSignatureIssues: () => false,
            };
        },
        unsafeDownloadToStream() {
            throw new Error('not used');
        },
        getSeekableStream() {
            let position = 0;
            return {
                seek(to: number) {
                    position = to;
                },
                async read(numBytes: number) {
                    if (position >= content.length) {
                        return { value: new Uint8Array(), done: true };
                    }
                    const value = content.subarray(position, Math.min(position + numBytes, content.length));
                    position += value.length;
                    return { value, done: false };
                },
            } as unknown as ReturnType<FileDownloader['getSeekableStream']>;
        },
        setSignal(signal: AbortSignal) {
            // Redirect the abort controller the download paths use onto the SDK's signal.
            signal.addEventListener('abort', () => abort.abort(), { once: true });
            if (signal.aborted) {
                abort.abort();
            }
        },
    };
}

function sdkWith(downloader: FileDownloader & { setSignal?(signal: AbortSignal): void }, calls: string[] = []): DriveSdk {
    return {
        getNode: async (uid: string) => {
            calls.push(`node:${uid}`);
            return { ok: true, value: { uid } };
        },
        getFileDownloader: async (uid: string, signal: AbortSignal) => {
            calls.push(`downloader:${uid}`);
            downloader.setSignal?.(signal);
            return downloader;
        },
    } as unknown as DriveSdk;
}

/**
 * Wraps the seekable streams of `downloader` so that each `read` waits until the test releases
 * it. Records where each read starts and how many bytes it asks for, in the order they start.
 */
function gatedReads(downloader: FileDownloader) {
    const reads: { position: number; count: number; release: () => void }[] = [];
    let openGate = false;
    const original = downloader.getSeekableStream.bind(downloader);
    downloader.getSeekableStream = () => {
        const seekable = original();
        let position = 0;
        const seek = seekable.seek.bind(seekable);
        seekable.seek = (to: number) => {
            position = to;
            return seek(to);
        };
        const read = seekable.read.bind(seekable);
        seekable.read = async (count: number) => {
            const gate = Promise.withResolvers<void>();
            reads.push({ position, count, release: gate.resolve });
            if (openGate) gate.resolve();
            await gate.promise;
            const result = await read(count);
            position += result.value.length;
            return result;
        };
        return seekable;
    };
    return {
        downloader,
        started: () => reads.map((read) => read.position),
        requested: () => reads.map((read) => read.count),
        release: (index: number) => reads[index]!.release(),
        releaseAll() {
            openGate = true;
            for (const read of reads) read.release();
        },
        settle: () => new Promise((resolve) => setTimeout(resolve, 10)),
    };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('sliceStream', () => {
    test('cuts a range across chunk borders', async () => {
        const sliced = sliceStream(streamOf(['abc', 'def', 'ghi']), 2, 6);
        expect(await new Response(sliced).text()).toBe('cdefg');
    });

    test('handles a range inside one chunk and at the end', async () => {
        expect(await new Response(sliceStream(streamOf(['abcdef']), 1, 2)).text()).toBe('bc');
        expect(await new Response(sliceStream(streamOf(['ab', 'cd']), 3, 10)).text()).toBe('d');
    });
});

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
}

describe('primeStream', () => {
    test('keeps every chunk', async () => {
        const primed = await primeStream(streamOf(['a', 'b', 'c']));
        expect(await new Response(primed).text()).toBe('abc');
    });

    test('rejects when the source fails before the first chunk, and aborts the download', async () => {
        const failing = new ReadableStream<Uint8Array>({
            pull() {
                throw new Error('integrity failure');
            },
        });
        const abort = new AbortController();
        await expect(primeStream(failing, abort)).rejects.toThrow('integrity failure');
        expect(abort.signal.aborted).toBe(true);
    });

    test('rejects when the client goes away before the first chunk', async () => {
        const never = new ReadableStream<Uint8Array>({ start() {} });
        const abort = new AbortController();
        const signal = abort.signal;
        const pending = primeStream(never, abort, signal);
        setTimeout(() => abort.abort(), 10);
        await expect(pending).rejects.toThrow(AbortError);
        expect(abort.signal.aborted).toBe(true);
    });
});

describe('openDownload', () => {
    test('a whole file streams through the SDK downloader', async () => {
        const content = bytes(2500);
        const downloader = fakeDownloader(content);
        const stream = await openDownload(sdkWith(downloader), fileEntry(content.length), { logger: QUIET });
        expect(await readAll(stream)).toEqual(content);
    });

    test('an exact byte range comes from the SDK seekable stream', async () => {
        const content = bytes(4096);
        const downloader = fakeDownloader(content);
        const seeks: number[] = [];
        const original = downloader.getSeekableStream.bind(downloader);
        downloader.getSeekableStream = () => {
            const seekable = original();
            const seek = seekable.seek.bind(seekable);
            seekable.seek = (position: number) => {
                seeks.push(position);
                return seek(position);
            };
            return seekable;
        };
        const stream = await openDownload(sdkWith(downloader), fileEntry(content.length), {
            range: { start: 1000, end: 1099 },
            logger: QUIET,
        });
        const got = await readAll(stream);
        expect(got.length).toBe(100);
        expect(got).toEqual(content.subarray(1000, 1100));
        expect(seeks).toEqual([1000]);
    });

    test('a whole-file range uses the verified download, not the seekable stream', async () => {
        const content = bytes(100);
        const downloader = fakeDownloader(content);
        const stream = await openDownload(sdkWith(downloader), fileEntry(content.length), {
            range: { start: 0, end: 99 },
            logger: QUIET,
        });
        expect(await readAll(stream)).toEqual(content);
    });

    test('a range the SDK cannot seek falls back to reading from the start and slicing', async () => {
        const content = bytes(4096);
        const downloader = fakeDownloader(content);
        downloader.getSeekableStream = () => {
            throw new Error('no block sizes for this revision');
        };
        const infos: string[] = [];
        const stream = await openDownload(sdkWith(downloader), fileEntry(content.length), {
            range: { start: 1000, end: 1099 },
            logger: { ...QUIET, info: (line: string) => infos.push(line) },
        });
        expect(await readAll(stream)).toEqual(content.subarray(1000, 1100));
        expect(infos.some((line) => line.includes('reading from the start'))).toBeTrue();
    });

    test('a downloader that fails to open throws and aborts the download', async () => {
        const errors: unknown[] = [];
        const sdk = {
            getNode: async () => ({ ok: true }),
            getFileDownloader: async () => {
                throw new Error('no download slot');
            },
        } as unknown as DriveSdk;
        await expect(openDownload(sdk, fileEntry(10), { logger: QUIET, onError: (e) => errors.push(e) })).rejects.toThrow(
            'no download slot',
        );
        expect(errors).toHaveLength(1);
    });

    test('a client that disconnects before the first byte stops the download', async () => {
        const observed: { aborted?: boolean } = {};
        const content = bytes(100_000); // slower than one tick, so the client can leave mid-flight
        const downloader = fakeDownloader(content, observed);
        const abort = new AbortController();
        const stream = await openDownload(sdkWith(downloader), fileEntry(content.length), {
            signal: abort.signal,
            logger: QUIET,
        });
        const body = new Response(stream);
        void body;
        abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(observed.aborted).toBeTrue();
    });

    test('a long range comes whole and in order, across read-ahead chunks', async () => {
        const content = bytes(3 * READ_AHEAD_CHUNK + 5000);
        const stream = await openDownload(sdkWith(fakeDownloader(content)), fileEntry(content.length), {
            range: { start: 1000, end: content.length - 2000 },
            logger: QUIET,
        });
        expect(await readAll(stream)).toEqual(content.subarray(1000, content.length - 1999));
    });

    test('a range read fetches the next chunks while the reader holds the current one, up to the read-ahead depth', async () => {
        const content = bytes((READ_AHEAD_DEPTH + 3) * READ_AHEAD_CHUNK);
        const gated = gatedReads(fakeDownloader(content));
        const opening = openDownload(sdkWith(gated.downloader), fileEntry(content.length), {
            range: { start: 10, end: content.length - 1 },
            logger: QUIET,
        });
        await gated.settle();
        // Before the first byte, every lane is already fetching.
        expect(gated.started()).toEqual([10, READ_AHEAD_CHUNK, 2 * READ_AHEAD_CHUNK, 3 * READ_AHEAD_CHUNK].slice(0, READ_AHEAD_DEPTH));
        gated.releaseAll();
        const stream = await opening;
        await gated.settle();
        // The reader holds the first chunk and has not asked for more: no fetch past the depth.
        expect(gated.started()).toHaveLength(READ_AHEAD_DEPTH);
        const reader = stream.getReader();
        await reader.read(); // the first chunk, read before the stream was handed over
        await reader.read();
        await gated.settle();
        // Taking the next chunk frees one place, so one more fetch starts.
        expect(gated.started()).toHaveLength(READ_AHEAD_DEPTH + 1);
        await reader.cancel();
    });

    test('a range read fetches nothing past the end of its range', async () => {
        const content = bytes(4 * READ_AHEAD_CHUNK);
        const gated = gatedReads(fakeDownloader(content));
        gated.releaseAll();
        const stream = await openDownload(sdkWith(gated.downloader), fileEntry(content.length), {
            range: { start: 0, end: READ_AHEAD_CHUNK + 99 },
            logger: QUIET,
        });
        expect((await readAll(stream)).length).toBe(READ_AHEAD_CHUNK + 100);
        expect(gated.started()).toEqual([0, READ_AHEAD_CHUNK]);
        expect(gated.requested()).toEqual([READ_AHEAD_CHUNK, 100]);
    });

    test('a reader that goes away aborts the fetches still out, and no more start', async () => {
        const observed: { aborted?: boolean } = {};
        const content = bytes((READ_AHEAD_DEPTH + 3) * READ_AHEAD_CHUNK);
        const gated = gatedReads(fakeDownloader(content, observed));
        const opening = openDownload(sdkWith(gated.downloader), fileEntry(content.length), {
            range: { start: 1, end: content.length - 1 }, // not the whole file, which skips the seekable stream
            logger: QUIET,
        });
        await gated.settle();
        gated.release(0);
        const stream = await opening;
        await stream.cancel();
        expect(observed.aborted).toBeTrue();
        gated.releaseAll();
        await gated.settle();
        expect(gated.started()).toHaveLength(READ_AHEAD_DEPTH);
    });

    test('a read-ahead fetch that fails errors the body once the reader reaches it, and aborts the rest', async () => {
        const observed: { aborted?: boolean } = {};
        const content = bytes(3 * READ_AHEAD_CHUNK);
        const downloader = fakeDownloader(content, observed);
        const original = downloader.getSeekableStream.bind(downloader);
        downloader.getSeekableStream = () => {
            const seekable = original();
            let position = 0;
            const seek = seekable.seek.bind(seekable);
            seekable.seek = (to: number) => {
                position = to;
                return seek(to);
            };
            const read = seekable.read.bind(seekable);
            seekable.read = (count: number) => (position === READ_AHEAD_CHUNK ? Promise.reject(new Error('block 2 failed')) : read(count));
            return seekable;
        };
        const errors: unknown[] = [];
        const stream = await openDownload(sdkWith(downloader), fileEntry(content.length), {
            range: { start: 1, end: content.length - 1 }, // not the whole file, which skips the seekable stream
            logger: QUIET,
            onError: (error) => errors.push(error),
        });
        const reader = stream.getReader();
        await reader.read();
        await expect(reader.read()).rejects.toThrow('block 2 failed');
        expect(errors).toHaveLength(1);
        expect(observed.aborted).toBeTrue();
    });

    test('a download that fails mid-stream errors the body', async () => {
        const downloader = fakeDownloader(bytes(500));
        downloader.downloadToStream = () => {
            return {
                pause() {},
                resume() {},
                completion: () => Promise.reject(new Error('verification failed')),
                isDownloadCompleteWithSignatureIssues: () => false,
            };
        };
        const errors: unknown[] = [];
        // The failure lands before the first chunk, so `openDownload` itself rejects.
        await expect(
            openDownload(sdkWith(downloader), fileEntry(500), { logger: QUIET, onError: (e) => errors.push(e) }),
        ).rejects.toThrow('verification failed');
        expect(errors).toHaveLength(1);
    });

    test('a read that waits for its node keys holds no download slot (#163)', async () => {
        // As the SDK: getFileDownloader takes one of 5 slots, then waits for the node's keys,
        // which getNode also unlocks. Five files' keys wait on crypto; one file's are ready.
        const slots = { used: 0, waiting: [] as (() => void)[] };
        const unlocks = new Map<string, Promise<void>>();
        const unlockAll: (() => void)[] = [];
        const keysOf = (uid: string) => {
            if (!unlocks.has(uid)) {
                unlocks.set(uid, uid === 'ready' ? Promise.resolve() : new Promise<void>((done) => unlockAll.push(done)));
            }
            return unlocks.get(uid)!;
        };
        const sdk = {
            getNode: async (uid: string) => {
                await keysOf(uid);
                return { ok: true, value: { uid } };
            },
            getFileDownloader: async (uid: string, signal: AbortSignal) => {
                while (slots.used >= 5) await new Promise<void>((free) => slots.waiting.push(free));
                slots.used++;
                await keysOf(uid);
                const downloader = fakeDownloader(bytes(10));
                downloader.setSignal(signal);
                signal.addEventListener('abort', () => {
                    slots.used--;
                    slots.waiting.shift()?.();
                });
                return downloader;
            },
        } as unknown as DriveSdk;
        const file = (uid: string) => ({ ...fileEntry(10), uid });

        const waiting = ['a', 'b', 'c', 'd', 'e'].map((uid) => openDownload(sdk, file(uid), { logger: QUIET }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        const ready = openDownload(sdk, file('ready'), { logger: QUIET });
        const first = await Promise.race([ready.then(readAll), new Promise((resolve) => setTimeout(() => resolve('blocked'), 200))]);
        expect(first).toEqual(bytes(10));

        for (const unlock of unlockAll) unlock();
        for (const read of await Promise.all(waiting)) expect(await readAll(read)).toEqual(bytes(10));
    });
});
