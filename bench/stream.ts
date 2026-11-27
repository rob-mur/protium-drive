import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { FileDownloader } from '@protontech/drive-sdk';

import { FakeDrive, FakeDriveClient } from '../fake-drive/drive';
import { openDownload } from '../src/drive/download';
import type { Entry } from '../src/drive/entry';
import type { DriveSdk } from '../src/drive/sdk';

import { timed } from './stats';

/** Proton's block size: the unit the SDK's seekable stream fetches. */
const BLOCK = 4 * 1024 * 1024;

export type StreamOptions = {
    /** Size of the file streamed. */
    mib: number;
    /** What one block fetch costs: its block token call and its block download. */
    blockMs: number;
};

export type StreamRow = {
    read: string;
    bytes: number;
    firstByteMs: number;
    totalMs: number;
};

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Makes every seekable stream of `downloader` cost `blockMs` per block it fetches, as the SDK's
 * does: a read fetches the blocks it needs one after the other and keeps what is left of the last
 * one, and a seek outside what it keeps starts over at the block of the new position. Streams
 * fetch at the same time without slowing each other.
 */
function withBlockLatency(downloader: FileDownloader, blockMs: number, size: number): FileDownloader {
    return {
        ...downloader,
        getSeekableStream() {
            const inner = downloader.getSeekableStream();
            const innerRead = inner.read.bind(inner);
            const innerSeek = inner.seek.bind(inner);
            let position = 0;
            let fetchedTo = 0;
            return Object.assign(inner, {
                async seek(to: number) {
                    if (to < position || to > fetchedTo) {
                        fetchedTo = Math.floor(to / BLOCK) * BLOCK;
                    }
                    position = to;
                    await innerSeek(to);
                },
                async read(count: number) {
                    const want = Math.min(position + count, size);
                    while (fetchedTo < want) {
                        await Bun.sleep(blockMs);
                        fetchedTo += BLOCK;
                    }
                    const result = await innerRead(count);
                    position += result.value.length;
                    return result;
                },
            });
        },
    };
}

/** Times range reads of one file of the fake Drive, as rclone asks for them: from near the start, and from a seek to the middle. */
export async function benchStream(options: StreamOptions): Promise<StreamRow[]> {
    const dir = await mkdtemp(path.join(tmpdir(), 'pdm-bench-stream-'));
    try {
        const size = options.mib * 1024 * 1024;
        const drive = FakeDrive.open(dir);
        const uid = drive.add('video.mkv', { type: 'file', content: new Uint8Array(size).fill(7), mediaType: 'video/x-matroska' });
        const client = new FakeDriveClient(drive);
        const sdk = {
            getNode: async (node: string) => client.getNode(node),
            getFileDownloader: async (node: string, signal?: AbortSignal) =>
                withBlockLatency(await client.getFileDownloader(node, signal), options.blockMs, size),
        } as unknown as DriveSdk;
        const file: Entry = {
            uid,
            name: 'video.mkv',
            kind: 'file',
            size,
            modified: new Date('2026-01-01T00:00:00Z'),
            created: new Date('2026-01-01T00:00:00Z'),
            revisionUid: `${uid}~revision`,
            treeEventScopeId: 'volume-1',
        };
        const reads = [
            // Not from byte 0: a range of the whole file takes the verified download instead.
            { read: 'from byte 1 to the end', start: 1 },
            { read: 'seek to the middle, read to the end', start: Math.floor(size / 2) + 12345 },
        ];
        const rows: StreamRow[] = [];
        for (const { read, start } of reads) {
            let firstByteMs = 0;
            const { ms, value: bytes } = await timed(async () => {
                const began = performance.now();
                const stream = await openDownload(sdk, file, { range: { start, end: size - 1 }, logger: QUIET });
                firstByteMs = performance.now() - began;
                const reader = stream.getReader();
                let total = 0;
                for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) total += chunk.value.length;
                return total;
            });
            if (bytes !== size - start) throw new Error(`${read}: got ${bytes} bytes, expected ${size - start}`);
            rows.push({ read, bytes, firstByteMs, totalMs: ms });
        }
        return rows;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
