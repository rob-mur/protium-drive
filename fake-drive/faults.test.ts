import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    AbortError,
    ConnectionError,
    IntegrityError,
    NodeWithSameNameExistsValidationError,
    RateLimitedError,
    ServerError,
} from '@protontech/drive-sdk';

import { FakeClock } from './clock.ts';
import { FakeDrive, FakeDriveClient, NAME_TAKEN, SCOPE_ID } from './drive.ts';
import { type Fault, FaultError, Faults } from './faults.ts';

let dir: string;
let drive: FakeDrive;
let faults: Faults;
let client: FakeDriveClient;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-drive-faults-'));
    drive = FakeDrive.open(dir);
    faults = new Faults();
    client = new FakeDriveClient(drive, { faults });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);

async function list(path: string): Promise<string[]> {
    const uids: string[] = [];
    for await (const uid of client.iterateFolderChildrenNodeUids(drive.nodeAt(path).uid)) uids.push(uid);
    return uids;
}

async function upload(parentPath: string, name: string, content: string): Promise<string> {
    const uploader = await client.getFileUploader(drive.nodeAt(parentPath).uid, name, { mediaType: 'text/plain', expectedSize: bytes(content).length });
    return (await (await uploader.uploadFromStream(new Blob([content]).stream(), [])).completion()).nodeUid;
}

async function overwrite(path: string, content: string): Promise<string> {
    const uploader = await client.getFileRevisionUploader(drive.nodeAt(path).uid, { mediaType: 'text/plain', expectedSize: bytes(content).length });
    return (await (await uploader.uploadFromStream(new Blob([content]).stream(), [])).completion()).nodeRevisionUid;
}

async function download(path: string): Promise<{ text: string; chunks: number }> {
    const downloader = await client.getFileDownloader(drive.nodeAt(path).uid);
    const chunks: Uint8Array[] = [];
    await downloader.downloadToStream(new WritableStream<Uint8Array>({ write: (chunk) => void chunks.push(chunk) })).completion();
    return { text: new TextDecoder().decode(Buffer.concat(chunks)), chunks: chunks.length };
}


describe('a fault set for one operation and one target', () => {
    const throwing = [
        { kind: 'rate-limited', error: RateLimitedError },
        { kind: 'server-error', error: ServerError },
        { kind: 'unreachable', error: ConnectionError },
    ] as const;

    for (const { kind, error } of throwing) {
        test(`${kind}: occurs on the next matching call only, and the call after it succeeds`, async () => {
            drive.add('Photos/beach.jpg', { type: 'file', content: bytes('sand and sea') });
            faults.add({ kind, operation: 'iterateFolderChildrenNodeUids', path: 'Photos' });

            await expect(list('Photos')).rejects.toBeInstanceOf(error);
            expect(await list('Photos')).toEqual([drive.nodeAt('Photos/beach.jpg').uid]);
            expect(faults.pending()).toEqual([]);
        });

        test(`${kind}: other operations and other targets do not see it`, async () => {
            drive.add('Photos/beach.jpg', { type: 'file', content: bytes('sand and sea') });
            drive.add('Docs', { type: 'folder' });
            faults.add({ kind, operation: 'iterateFolderChildrenNodeUids', path: 'Photos' });

            expect(await list('Docs')).toEqual([]);
            expect(await list('')).toHaveLength(2);
            expect((await client.getNode(drive.nodeAt('Photos').uid)).uid).toBe(drive.nodeAt('Photos').uid);
            expect((await download('Photos/beach.jpg')).text).toBe('sand and sea');
            expect(faults.pending()).toHaveLength(1);
            await expect(list('Photos')).rejects.toBeInstanceOf(error);
        });
    }

    test('a rate limit is the RateLimitedError the SDK throws once its own 429 retries give up', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'rate-limited', operation: 'iterateFolderChildrenNodeUids', path: 'Photos' });
        const error = await list('Photos').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RateLimitedError);
        expect(error).toMatchObject({ name: 'RateLimitedError', code: 429, statusCode: 429 });
    });

    test('a server error is a ServerError with status 500, and not a rate limit', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'server-error', operation: 'iterateFolderChildrenNodeUids', path: 'Photos' });
        const error = await list('Photos').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ServerError);
        expect(error).not.toBeInstanceOf(RateLimitedError);
        expect(error).toMatchObject({ statusCode: 500 });
    });

    test('two faults on one target occur on the next two matching calls', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'rate-limited', operation: 'iterateFolderChildrenNodeUids', path: 'Photos' });
        faults.add({ kind: 'server-error', operation: 'iterateFolderChildrenNodeUids', path: '/Photos/' });

        await expect(list('Photos')).rejects.toBeInstanceOf(RateLimitedError);
        await expect(list('Photos')).rejects.toMatchObject({ statusCode: 500 });
        expect(await list('Photos')).toEqual([]);
    });

    test('a fault on a node follows the node by its path at the time of the call', async () => {
        drive.add('Photos/beach.jpg', { type: 'file', content: bytes('sand and sea') });
        faults.add({ kind: 'unreachable', operation: 'getNode', path: 'Photos/beach.jpg' });
        const uid = drive.nodeAt('Photos/beach.jpg').uid;
        drive.rename('Photos/beach.jpg', 'dune.jpg');

        expect((await client.getNode(uid)).uid).toBe(uid);
        drive.add('Photos/beach.jpg', { type: 'file', content: bytes('new') });
        await expect(client.getNode(drive.nodeAt('Photos/beach.jpg').uid)).rejects.toBeInstanceOf(ConnectionError);
    });

    test('a fault on a generator call occurs when the product starts to iterate it, and the Drive counts the call', async () => {
        drive.add('Photos/beach.jpg', { type: 'file', content: bytes('sand and sea') });
        const uid = drive.nodeAt('Photos/beach.jpg').uid;
        faults.add({ kind: 'server-error', operation: 'iterateNodes', path: 'Photos/beach.jpg' });
        faults.add({ kind: 'unreachable', operation: 'trashNodes', path: 'Photos/beach.jpg' });

        const loads = client.iterateNodes([uid]);
        expect(faults.pending()).toHaveLength(2);
        await expect(loads.next()).rejects.toBeInstanceOf(ServerError);
        await expect(client.trashNodes([uid]).next()).rejects.toBeInstanceOf(ConnectionError);
        expect(drive.trashed()).toEqual([]);
        expect(client.calls().methods).toEqual({ iterateNodes: 1, trashNodes: 1 });
    });

    test('a fault on a move, a rename or the event scheduler occurs on the next matching call', async () => {
        drive.add('Photos/beach.jpg', { type: 'file', content: bytes('sand and sea') });
        drive.add('Docs', { type: 'folder' });
        const uid = drive.nodeAt('Photos/beach.jpg').uid;
        faults.add({ kind: 'unreachable', operation: 'moveNodes', path: 'Photos/beach.jpg' });
        faults.add({ kind: 'server-error', operation: 'renameNode', path: 'Photos/beach.jpg' });
        faults.add({ kind: 'rate-limited', operation: 'getEventScheduler', path: '' });

        await expect(client.moveNodes([uid], drive.nodeAt('Docs').uid).next()).rejects.toBeInstanceOf(ConnectionError);
        expect(drive.nodeAt('Photos/beach.jpg').uid).toBe(uid);
        await expect(client.renameNode(uid, 'dune.jpg')).rejects.toBeInstanceOf(ServerError);
        expect(drive.nodeAt('Photos/beach.jpg').uid).toBe(uid);
        await expect(client.getEventScheduler(async () => {})).rejects.toBeInstanceOf(RateLimitedError);
        expect(faults.pending()).toEqual([]);

        await client.renameNode(uid, 'dune.jpg');
        expect(drive.nodeAt('Photos/dune.jpg').uid).toBe(uid);
        (await client.getEventScheduler(async () => {})).addScope(SCOPE_ID);
    });

    test('a call on a trashed node does not meet a fault aimed at its old path', async () => {
        drive.add('A/b.txt', { type: 'file', content: bytes('old') });
        const trashedUid = drive.nodeAt('A/b.txt').uid;
        drive.trash('A/b.txt');
        faults.add({ kind: 'server-error', operation: 'getNode', path: 'A/b.txt' });

        expect((await client.getNode(trashedUid)).uid).toBe(trashedUid);
        expect(faults.pending()).toHaveLength(1);
        drive.add('A/b.txt', { type: 'file', content: bytes('new') });
        await expect(client.getNode(drive.nodeAt('A/b.txt').uid)).rejects.toBeInstanceOf(ServerError);
    });

    test('a call on a node in a trashed folder does not meet a fault aimed at its old path', async () => {
        drive.add('A/b.txt', { type: 'file', content: bytes('old') });
        const uid = drive.nodeAt('A/b.txt').uid;
        drive.trash('A');
        faults.add({ kind: 'server-error', operation: 'getNode', path: 'A/b.txt' });
        expect((await client.getNode(uid)).uid).toBe(uid);
        expect(faults.pending()).toHaveLength(1);
    });

    test('My files itself is the target "" for the root folder, the event scheduler and the Drive events', async () => {
        faults.add({ kind: 'unreachable', operation: 'getMyFilesRootFolder', path: '' });
        faults.add({ kind: 'unreachable', operation: 'iterateEvents', path: '/' });
        await expect(client.getMyFilesRootFolder()).rejects.toBeInstanceOf(ConnectionError);
        await expect(client.iterateEvents('volume-1').next()).rejects.toBeInstanceOf(ConnectionError);
        expect((await client.iterateEvents('volume-1').next()).done).toBe(false);
    });

    test('a fault on a create aims at the folder or at the new path', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'server-error', operation: 'createFolder', path: 'Photos' });
        faults.add({ kind: 'unreachable', operation: 'createFolder', path: 'Photos/2026' });
        const photos = drive.nodeAt('Photos').uid;

        await expect(client.createFolder(photos, 'any')).rejects.toBeInstanceOf(ServerError);
        await expect(client.createFolder(photos, 'other')).resolves.toBeDefined();
        await expect(client.createFolder(photos, '2026')).rejects.toBeInstanceOf(ConnectionError);
        await expect(client.createFolder(photos, '2026')).resolves.toBeDefined();
    });
});

describe('an integrity failure on a download', () => {
    test('fails before the first byte, on the next download of that file only', async () => {
        drive.add('Photos/beach.jpg', { type: 'file', content: bytes('sand and sea') });
        drive.add('Photos/dune.jpg', { type: 'file', content: bytes('sand') });
        faults.add({ kind: 'integrity', operation: 'getFileDownloader', path: 'Photos/beach.jpg' });

        expect((await download('Photos/dune.jpg')).text).toBe('sand');
        const downloader = await client.getFileDownloader(drive.nodeAt('Photos/beach.jpg').uid);
        const chunks: Uint8Array[] = [];
        const controller = downloader.downloadToStream(new WritableStream<Uint8Array>({ write: (chunk) => void chunks.push(chunk) }));
        await expect(controller.completion()).rejects.toBeInstanceOf(IntegrityError);
        expect(chunks).toEqual([]);

        expect((await download('Photos/beach.jpg')).text).toBe('sand and sea');
    });

    test('a download the product starts and drops causes no unhandled rejection', async () => {
        const unhandled: unknown[] = [];
        const record = (reason: unknown) => void unhandled.push(reason);
        process.on('unhandledRejection', record);
        try {
            drive.add('beach.jpg', { type: 'file', content: bytes('sand and sea') });
            faults.add({ kind: 'integrity', operation: 'getFileDownloader', path: 'beach.jpg' });
            const downloader = await client.getFileDownloader(drive.nodeAt('beach.jpg').uid);
            downloader.downloadToStream(new WritableStream<Uint8Array>());
            await Bun.sleep(5);
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', record);
        }
    });

    test('fails a seekable read too, before the first byte', async () => {
        drive.add('beach.jpg', { type: 'file', content: bytes('sand and sea') });
        faults.add({ kind: 'integrity', operation: 'getFileDownloader', path: 'beach.jpg' });
        const stream = (await client.getFileDownloader(drive.nodeAt('beach.jpg').uid)).getSeekableStream();
        await expect(stream.read(4)).rejects.toBeInstanceOf(IntegrityError);
        await expect(stream.getReader().read()).rejects.toBeInstanceOf(IntegrityError);
    });
});

describe('a name clash on an upload', () => {
    test('refuses the next upload into the folder with NodeWithSameNameExistsValidationError, then lets one through', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'name-clash', operation: 'getFileUploader', path: 'Photos' });

        const error = await upload('Photos', 'beach.jpg', 'sand and sea').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NodeWithSameNameExistsValidationError);
        expect(error).toMatchObject({ code: NAME_TAKEN });
        expect(() => drive.nodeAt('Photos/beach.jpg')).toThrow();
        await upload('Photos', 'beach.jpg', 'sand and sea');
        expect(new TextDecoder().decode(drive.content('Photos/beach.jpg'))).toBe('sand and sea');
    });
});

describe('an upload that fails part-way', () => {
    test('reads part of the content, fails, and leaves no new file in the Drive', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'upload-part-way', operation: 'getFileUploader', path: 'Photos/beach.jpg' });
        const before = drive.eventsAfter('0');

        let pulled = 0;
        let cancelled = false;
        const chunk = new Uint8Array(1024).fill(7);
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled++;
                if (pulled > 8) controller.close();
                else controller.enqueue(chunk);
            },
            cancel() {
                cancelled = true;
            },
        }, { highWaterMark: 0 });
        const uploader = await client.getFileUploader(drive.nodeAt('Photos').uid, 'beach.jpg', { mediaType: 'image/jpeg', expectedSize: 8 * 1024 });
        const controller = await uploader.uploadFromStream(stream, []);
        await expect(controller.completion()).rejects.toBeInstanceOf(ConnectionError);

        expect(pulled).toBeGreaterThan(0);
        expect(pulled).toBeLessThan(8);
        // As the SDK when an upload fails: it cancels the product's stream.
        expect(cancelled).toBe(true);
        expect(() => drive.nodeAt('Photos/beach.jpg')).toThrow();
        expect(drive.eventsAfter('0')).toEqual(before);
        await upload('Photos', 'beach.jpg', 'sand and sea');
    });

    test('on an overwrite, it leaves the file and its revisions as they were', async () => {
        drive.add('Photos/beach.jpg', { type: 'file', content: bytes('sand and sea') });
        faults.add({ kind: 'upload-part-way', operation: 'getFileRevisionUploader', path: 'Photos/beach.jpg' });
        const node = drive.nodeAt('Photos/beach.jpg');
        const revisions = drive.revisions('Photos/beach.jpg');

        await expect(overwrite('Photos/beach.jpg', 'sand and snow')).rejects.toBeInstanceOf(ConnectionError);
        expect(drive.nodeAt('Photos/beach.jpg')).toEqual(node);
        expect(drive.revisions('Photos/beach.jpg')).toEqual(revisions);
        expect(new TextDecoder().decode(drive.content('Photos/beach.jpg'))).toBe('sand and sea');
        expect(drive.trashed()).toEqual([]);

        await overwrite('Photos/beach.jpg', 'sand and snow');
        expect(new TextDecoder().decode(drive.content('Photos/beach.jpg'))).toBe('sand and snow');
    });

    test('an empty upload fails too, with nothing to read', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'upload-part-way', operation: 'getFileUploader', path: 'Photos' });
        await expect(upload('Photos', 'empty', '')).rejects.toBeInstanceOf(ConnectionError);
        expect(() => drive.nodeAt('Photos/empty')).toThrow();
    });
});

describe('an upload that stops moving bytes', () => {
    test('reads part of the content, reports no progress, and fails with AbortError once its signal aborts', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'upload-stall', operation: 'getFileUploader', path: 'Photos' });
        const abort = new AbortController();
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            pull: (controller) => controller.enqueue(new Uint8Array(1024)),
            cancel() {
                cancelled = true;
            },
        }, { highWaterMark: 0 });
        const progress: number[] = [];
        const uploader = await client.getFileUploader(drive.nodeAt('Photos').uid, 'beach.jpg', { mediaType: 'image/jpeg', expectedSize: 8 * 1024 }, abort.signal);
        const controller = await uploader.uploadFromStream(stream, [], (bytes) => progress.push(bytes));
        const outcome = controller.completion().then(() => 'done', (error: unknown) => error);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await Promise.race([outcome, 'still running'])).toBe('still running');

        abort.abort();
        expect(await outcome).toBeInstanceOf(AbortError);
        expect(progress).toEqual([]);
        expect(cancelled).toBe(true);
        expect(() => drive.nodeAt('Photos/beach.jpg')).toThrow();
        await upload('Photos', 'beach.jpg', 'sand and sea');
    });

    test('on an overwrite, it leaves the file as it was', async () => {
        drive.add('Photos/beach.jpg', { type: 'file', content: bytes('sand and sea') });
        faults.add({ kind: 'upload-stall', operation: 'getFileRevisionUploader', path: 'Photos/beach.jpg' });
        const abort = new AbortController();
        const uploader = await client.getFileRevisionUploader(drive.nodeAt('Photos/beach.jpg').uid, { mediaType: 'text/plain', expectedSize: 13 }, abort.signal);
        const controller = await uploader.uploadFromStream(new Blob(['sand and snow']).stream(), []);
        abort.abort();
        await expect(controller.completion()).rejects.toBeInstanceOf(AbortError);
        expect(new TextDecoder().decode(drive.content('Photos/beach.jpg'))).toBe('sand and sea');
    });
});

describe('an upload that moves slowly', () => {
    test('reports one part of the content each minute of the clock, and commits after the tenth', async () => {
        const clock = new FakeClock();
        client = new FakeDriveClient(drive, { faults, clock });
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'upload-slow', operation: 'getFileUploader', path: 'Photos' });
        const progress: number[] = [];
        const uploader = await client.getFileUploader(drive.nodeAt('Photos').uid, 'beach.jpg', { mediaType: 'image/jpeg', expectedSize: 20 });
        const controller = await uploader.uploadFromStream(new Blob(['0123456789abcdefghij']).stream(), [], (bytes) => progress.push(bytes));
        const outcome = controller.completion();

        await clock.advance(9 * 60_000);
        expect(progress).toHaveLength(9);
        expect(() => drive.nodeAt('Photos/beach.jpg')).toThrow();

        await clock.advance(60_000);
        expect(progress).toEqual(Array(10).fill(2));
        await outcome;
        expect(new TextDecoder().decode(drive.content('Photos/beach.jpg'))).toBe('0123456789abcdefghij');
    });

    test('fails with AbortError when its signal aborts, and commits nothing', async () => {
        const clock = new FakeClock();
        client = new FakeDriveClient(drive, { faults, clock });
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'upload-slow', operation: 'getFileUploader', path: 'Photos' });
        const abort = new AbortController();
        const uploader = await client.getFileUploader(drive.nodeAt('Photos').uid, 'beach.jpg', { mediaType: 'image/jpeg', expectedSize: 2 }, abort.signal);
        const controller = await uploader.uploadFromStream(new Blob(['ab']).stream(), []);
        await clock.advance(3 * 60_000);
        abort.abort();
        await expect(controller.completion()).rejects.toBeInstanceOf(AbortError);
        await clock.advance(10 * 60_000);
        expect(() => drive.nodeAt('Photos/beach.jpg')).toThrow();
        expect(clock.pending()).toEqual([]);
    });

    test('cannot be set on a Receive arm without a clock', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'upload-slow', operation: 'getFileUploader', path: 'Photos' });
        await expect(upload('Photos', 'beach.jpg', 'ab')).rejects.toThrow('clock');
    });
});

describe('an upload that waits for its uploader', () => {
    test('gets no uploader until its signal aborts, then fails with AbortError and starts no upload', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'upload-wait', operation: 'getFileUploader', path: 'Photos' });
        const abort = new AbortController();
        const outcome = client
            .getFileUploader(drive.nodeAt('Photos').uid, 'beach.jpg', { mediaType: 'image/jpeg', expectedSize: 12 }, abort.signal)
            .then(() => 'uploader', (error: unknown) => error);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await Promise.race([outcome, 'still waiting'])).toBe('still waiting');

        abort.abort();
        expect(await outcome).toBeInstanceOf(AbortError);
        expect(client.calls().methods.uploadFromStream).toBeUndefined();
        expect(() => drive.nodeAt('Photos/beach.jpg')).toThrow();
        await upload('Photos', 'beach.jpg', 'sand and sea');
    });

    test('on an overwrite, it leaves the file as it was', async () => {
        drive.add('Photos/beach.jpg', { type: 'file', content: bytes('sand and sea') });
        faults.add({ kind: 'upload-wait', operation: 'getFileRevisionUploader', path: 'Photos/beach.jpg' });
        const abort = new AbortController();
        const waiting = client.getFileRevisionUploader(drive.nodeAt('Photos/beach.jpg').uid, { mediaType: 'text/plain', expectedSize: 13 }, abort.signal);
        abort.abort();
        await expect(waiting).rejects.toBeInstanceOf(AbortError);
        expect(new TextDecoder().decode(drive.content('Photos/beach.jpg'))).toBe('sand and sea');
    });
});

describe('an upload that waits behind another', () => {
    test('gets no uploader until another upload ends, then uploads', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'upload-stall', operation: 'getFileUploader', path: 'Photos/beach.jpg' });
        faults.add({ kind: 'upload-queued', operation: 'getFileUploader', path: 'Photos/dunes.jpg' });
        const stall = new AbortController();
        const stalled = await client.getFileUploader(drive.nodeAt('Photos').uid, 'beach.jpg', { mediaType: 'image/jpeg', expectedSize: 12 }, stall.signal);
        const stalledUpload = (await stalled.uploadFromStream(new Blob(['sand and sea']).stream(), [])).completion();
        stalledUpload.catch(() => {});
        const queued = client.getFileUploader(drive.nodeAt('Photos').uid, 'dunes.jpg', { mediaType: 'text/plain', expectedSize: 10 }, new AbortController().signal);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await Promise.race([queued.then(() => 'uploader'), 'still waiting'])).toBe('still waiting');

        stall.abort();
        await expect(stalledUpload).rejects.toBeInstanceOf(AbortError);
        await (await (await queued).uploadFromStream(new Blob(['sand dunes']).stream(), [])).completion();
        expect(new TextDecoder().decode(drive.content('Photos/dunes.jpg'))).toBe('sand dunes');
    });

    test('fails with AbortError if its signal aborts first, and starts no upload', async () => {
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'upload-queued', operation: 'getFileUploader', path: 'Photos' });
        const abort = new AbortController();
        const waiting = client.getFileUploader(drive.nodeAt('Photos').uid, 'dunes.jpg', { mediaType: 'text/plain', expectedSize: 10 }, abort.signal);
        abort.abort();
        await expect(waiting).rejects.toBeInstanceOf(AbortError);
        expect(client.calls().methods.uploadFromStream).toBeUndefined();
    });

    test('on an overwrite, it also waits for another upload to end', async () => {
        drive.add('Photos/dunes.jpg', { type: 'file', content: bytes('sand dunes') });
        faults.add({ kind: 'upload-queued', operation: 'getFileRevisionUploader', path: 'Photos/dunes.jpg' });
        const waiting = client
            .getFileRevisionUploader(drive.nodeAt('Photos/dunes.jpg').uid, { mediaType: 'text/plain', expectedSize: 11 }, new AbortController().signal)
            .then(() => 'uploader');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await Promise.race([waiting, 'still waiting'])).toBe('still waiting');

        await upload('Photos', 'beach.jpg', 'sand and sea');
        expect(await waiting).toBe('uploader');
    });
});

describe('every upload', () => {
    test('is counted when it starts, and reports its bytes as progress', async () => {
        drive.add('Photos', { type: 'folder' });
        const progress: number[] = [];
        const uploader = await client.getFileUploader(drive.nodeAt('Photos').uid, 'beach.jpg', { mediaType: 'image/jpeg', expectedSize: 12 });
        const controller = await uploader.uploadFromStream(new Blob(['sand and sea']).stream(), [], (bytes) => progress.push(bytes));
        expect(client.calls().methods.uploadFromStream).toBe(1);
        await controller.completion();
        expect(progress).toEqual([12]);
    });
});

describe('setting a fault', () => {
    test('refuses an unknown kind or operation, and a kind on an operation it cannot occur on', () => {
        const bad: unknown[] = [
            { kind: 'meteor', operation: 'getNode', path: 'a' },
            { kind: 'unreachable', operation: 'deleteEverything', path: 'a' },
            { kind: 'unreachable', operation: 'getNode' },
            { kind: 'integrity', operation: 'iterateFolderChildrenNodeUids', path: 'a' },
            { kind: 'name-clash', operation: 'getFileRevisionUploader', path: 'a' },
            { kind: 'upload-part-way', operation: 'getFileDownloader', path: 'a' },
            { kind: 'upload-stall', operation: 'getFileDownloader', path: 'a' },
            { kind: 'upload-slow', operation: 'createFolder', path: 'a' },
            { kind: 'upload-wait', operation: 'getFileDownloader', path: 'a' },
            { kind: 'upload-queued', operation: 'getFileDownloader', path: 'a' },
            null,
        ];
        for (const fault of bad) expect(() => faults.add(fault as Fault)).toThrow(FaultError);
        expect(faults.pending()).toEqual([]);
    });

    test('lists the faults not yet consumed, in the order they were set, with their paths made plain', () => {
        faults.add({ kind: 'unreachable', operation: 'getNode', path: '/a/b/' });
        faults.add({ kind: 'integrity', operation: 'getFileDownloader', path: 'c' });
        expect(faults.pending()).toEqual([
            { kind: 'unreachable', operation: 'getNode', path: 'a/b' },
            { kind: 'integrity', operation: 'getFileDownloader', path: 'c' },
        ]);
    });

    test('a client with no faults behaves as before', async () => {
        const plain = new FakeDriveClient(drive);
        drive.add('Photos', { type: 'folder' });
        faults.add({ kind: 'unreachable', operation: 'iterateFolderChildrenNodeUids', path: 'Photos' });
        const uids: string[] = [];
        for await (const uid of plain.iterateFolderChildrenNodeUids(drive.nodeAt('Photos').uid)) uids.push(uid);
        expect(uids).toEqual([]);
    });
});
