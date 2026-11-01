import { describe, expect, test } from 'bun:test';
import { AbortError, type FileDownloader } from '@protontech/drive-sdk';

import type { Entry } from './entry.ts';
import { openDownload, primeStream, sliceStream } from './download.ts';
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
            signal.addEventListener('abort', () => {
                observed.aborted = true;
            });
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
        getFileDownloader: async (uid: string, signal: AbortSignal) => {
            calls.push(`downloader:${uid}`);
            downloader.setSignal?.(signal);
            return downloader;
        },
    } as unknown as DriveSdk;
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
});
