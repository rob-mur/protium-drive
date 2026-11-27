import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    AbortError,
    type DriveEvent,
    DriveEventType,
    IntegrityError,
    type NodeEntity,
    NodeType,
    NodeWithSameNameExistsValidationError,
    ValidationError,
} from '@protontech/drive-sdk';

import { FakeDrive, FakeDriveClient, NoSuchNodeError, SCOPE_ID } from './drive.ts';
import { armoredNodeKey } from './node-keys.ts';

let dir: string;
let drive: FakeDrive;
let client: FakeDriveClient;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-drive-'));
    drive = FakeDrive.open(dir);
    client = new FakeDriveClient(drive);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

async function upload(parent: string, name: string, content: string, mediaType = 'text/plain'): Promise<string> {
    const uploader = await client.getFileUploader(parent, name, { mediaType, expectedSize: bytes(content).length });
    const controller = await uploader.uploadFromStream(new Blob([content]).stream(), []);
    return (await controller.completion()).nodeUid;
}

async function overwrite(uid: string, content: string, mediaType = 'text/plain'): Promise<string> {
    const uploader = await client.getFileRevisionUploader(uid, { mediaType, expectedSize: bytes(content).length });
    const controller = await uploader.uploadFromStream(new Blob([content]).stream(), []);
    return (await controller.completion()).nodeRevisionUid;
}

async function download(uid: string): Promise<string> {
    const downloader = await client.getFileDownloader(uid);
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({ write: (chunk) => void chunks.push(chunk) });
    await downloader.downloadToStream(writable).completion();
    return text(Buffer.concat(chunks));
}

async function children(parent: string): Promise<NodeEntity[]> {
    const uids: string[] = [];
    for await (const uid of client.iterateFolderChildrenNodeUids(parent)) uids.push(uid);
    const nodes: NodeEntity[] = [];
    for await (const node of client.iterateNodes(uids)) {
        if ('missingUid' in node) throw new Error(`missing ${node.missingUid}`);
        nodes.push(node);
    }
    return nodes;
}

async function events(lastEventId?: string): Promise<DriveEvent[]> {
    const out: DriveEvent[] = [];
    for await (const event of client.iterateEvents(SCOPE_ID, lastEventId)) out.push(event);
    return out;
}

async function latestEventId(): Promise<string> {
    const [fastForward] = await events();
    return fastForward!.eventId;
}

const nameOf = (node: NodeEntity) => (node.name.ok ? node.name.value : undefined);

describe('My files', () => {
    test('an empty DIR gives an empty root folder in the Drive event scope', async () => {
        const root = await client.getMyFilesRootFolder();
        expect(root.type).toBe(NodeType.Folder);
        expect(root.treeEventScopeId).toBe(SCOPE_ID);
        expect(root.parentUid).toBeUndefined();
        expect(await children(root.uid)).toEqual([]);
    });

    test('a folder and an uploaded file appear in the listing with their media type and size', async () => {
        const root = await client.getMyFilesRootFolder();
        const folder = await client.createFolder(root, 'Docs');
        const uid = await upload(folder.uid, 'a.txt', 'hello', 'text/markdown');

        const [file] = await children(folder.uid);
        expect(file!.uid).toBe(uid);
        expect(nameOf(file!)).toBe('a.txt');
        expect(file!.type).toBe(NodeType.File);
        expect(file!.parentUid).toBe(folder.uid);
        expect(file!.mediaType).toBe('text/markdown');
        expect(file!.activeRevision?.claimedSize).toBe(5);
        expect(await download(uid)).toBe('hello');
        expect(nameOf(await client.getNode(uid))).toBe('a.txt');
    });

    test('a listing filters by folder, and refuses any other filter type, as the SDK does', async () => {
        const root = await client.getMyFilesRootFolder();
        const folder = await client.createFolder(root, 'Docs');
        await upload(root.uid, 'a.txt', 'a');

        const folders: string[] = [];
        for await (const uid of client.iterateFolderChildrenNodeUids(root, { type: NodeType.Folder })) folders.push(uid);
        expect(folders).toEqual([folder.uid]);

        const files = async () => {
            for await (const _ of client.iterateFolderChildrenNodeUids(root, { type: NodeType.File })) void _;
        };
        await expect(files()).rejects.toThrow('Filter options supports only folders');
    });

    test('a listing of a folder UID that does not exist throws', async () => {
        const list = async () => {
            for await (const _ of client.iterateFolderChildrenNodeUids('volume-1~nope')) void _;
        };
        await expect(list()).rejects.toBeInstanceOf(ValidationError);
    });

    test('a new folder keeps the caller’s time as its claimed modification time, apart from the server time', async () => {
        const root = await client.getMyFilesRootFolder();
        const claimed = new Date('2001-02-03T04:05:06.000Z');
        const before = Date.now();
        const folder = await client.createFolder(root, 'Docs', claimed);

        for (const node of [folder, await client.getNode(folder.uid)]) {
            expect(node.folder).toEqual({ isImported: false, claimedModificationTime: claimed });
            expect(node.modificationTime.getTime()).toBeGreaterThanOrEqual(before);
        }
        const plain = await client.createFolder(root, 'Plain');
        expect(plain.folder).toEqual({ isImported: false, claimedModificationTime: undefined });
    });

    test('a file keeps the upload’s claimed time; a revision, a rename and a move each move its server time on', async () => {
        const root = await client.getMyFilesRootFolder();
        const docs = await client.createFolder(root, 'Docs');
        const claimed = new Date('2001-02-03T04:05:06.000Z');
        const uploader = await client.getFileUploader(root, 'a.txt', { mediaType: 'text/plain', expectedSize: 1, modificationTime: claimed });
        const { nodeUid: uid } = await (await uploader.uploadFromStream(new Blob(['a']).stream(), [])).completion();

        const first = await client.getNode(uid);
        expect(first.activeRevision?.claimedModificationTime).toEqual(claimed);
        const created = first.creationTime.getTime();
        let last = first.modificationTime.getTime();
        const steps = [
            () => overwrite(uid, 'b'),
            () => client.renameNode(uid, 'b.txt'),
            async () => {
                for await (const _ of client.moveNodes([uid], docs)) void _;
            },
        ];
        for (const step of steps) {
            await Bun.sleep(2);
            await step();
            const node = await client.getNode(uid);
            expect(node.modificationTime.getTime()).toBeGreaterThan(last);
            expect(node.creationTime.getTime()).toBe(created);
            last = node.modificationTime.getTime();
        }
    });

    test('a node’s total storage size is the sum of its revision sizes', async () => {
        const root = await client.getMyFilesRootFolder();
        const uid = await upload(root.uid, 'a.txt', 'abc');
        await overwrite(uid, 'defgh');
        expect((await client.getNode(uid)).totalStorageSize).toBe(8);
    });

    test('an upload with no expected size completes', async () => {
        const root = await client.getMyFilesRootFolder();
        const uploader = await client.getFileUploader(root, 'a.txt', { mediaType: 'text/plain', expectedSize: null });
        const { nodeUid } = await (await uploader.uploadFromStream(new Blob(['hello']).stream(), [])).completion();
        expect(await download(nodeUid)).toBe('hello');
    });

    test('a rename to the name the node has already succeeds', async () => {
        const root = await client.getMyFilesRootFolder();
        const uid = await upload(root.uid, 'a.txt', 'a');
        expect(nameOf(await client.renameNode(uid, 'a.txt'))).toBe('a.txt');
    });

    test('a new folder or an upload into a file, and a revision upload onto a folder or an unknown UID, are refused', async () => {
        const root = await client.getMyFilesRootFolder();
        const file = await upload(root.uid, 'a.txt', 'a');
        const folder = await client.createFolder(root, 'Docs');
        const metadata = { mediaType: 'text/plain', expectedSize: 1 };

        await expect(client.createFolder(file, 'Sub')).rejects.toThrow('is not a folder');
        await expect(client.getFileUploader(file, 'b.txt', metadata)).rejects.toThrow('is not a folder');
        const onFolder = await client.getFileRevisionUploader(folder.uid, metadata);
        await expect((await onFolder.uploadFromStream(new Blob(['a']).stream(), [])).completion()).rejects.toThrow('is not a file');
        await expect(client.getFileRevisionUploader('volume-1~nope', metadata)).rejects.toBeInstanceOf(NoSuchNodeError);
        expect(drive.childUids(file)).toEqual([]);
        expect(drive.nodeAt('Docs').revisionCount).toBe(0);
    });

    test('a download of a folder is refused', async () => {
        const root = await client.getMyFilesRootFolder();
        const folder = await client.createFolder(root, 'Docs');
        await expect(client.getFileDownloader(folder.uid)).rejects.toThrow('is not a file');
    });

    test('iterateNodes reports a UID it does not know as missing', async () => {
        const out = [];
        for await (const node of client.iterateNodes(['volume-1~nope'])) out.push(node);
        expect(out).toEqual([{ missingUid: 'volume-1~nope' }]);
    });

    test('a rename and a move keep the node UID, the content, the media type and the declared size', async () => {
        const root = await client.getMyFilesRootFolder();
        const docs = await client.createFolder(root, 'Docs');
        const archive = await client.createFolder(root, 'Archive');
        const uid = await upload(docs.uid, 'a.txt', 'hello', 'text/markdown');

        await client.renameNode(uid, 'b.txt');
        for await (const result of client.moveNodes([uid], archive)) expect(result).toEqual({ uid, ok: true });

        const node = drive.nodeAt('Archive/b.txt');
        expect(node.uid).toBe(uid);
        expect(text(drive.content('Archive/b.txt'))).toBe('hello');
        expect(drive.revisions('Archive/b.txt')).toMatchObject([{ mediaType: 'text/markdown', declaredSize: 5, size: 5 }]);
        expect(() => drive.nodeAt('Docs/a.txt')).toThrow();
    });

    test('a name that is taken refuses a new folder, an upload, a rename and a move', async () => {
        const root = await client.getMyFilesRootFolder();
        const docs = await client.createFolder(root, 'Docs');
        await upload(root.uid, 'a.txt', 'a');
        const b = await upload(root.uid, 'b.txt', 'b');
        await upload(docs.uid, 'b.txt', 'b');

        await expect(client.createFolder(root, 'Docs')).rejects.toBeInstanceOf(NodeWithSameNameExistsValidationError);
        await expect(client.getFileUploader(root, 'a.txt', { mediaType: 'text/plain', expectedSize: 1 })).rejects.toBeInstanceOf(
            NodeWithSameNameExistsValidationError,
        );
        await expect(client.renameNode(b, 'a.txt')).rejects.toBeInstanceOf(ValidationError);
        for await (const result of client.moveNodes([b], docs)) expect(result.ok).toBe(false);
    });

    test('an empty name, or one longer than 255 characters, is refused as the SDK refuses it', async () => {
        const root = await client.getMyFilesRootFolder();
        const uid = await upload(root.uid, 'a.txt', 'a');
        const long = 'x'.repeat(256);

        for (const name of ['', long]) {
            await expect(client.createFolder(root, name)).rejects.toBeInstanceOf(ValidationError);
            await expect(client.getFileUploader(root, name, { mediaType: 'text/plain', expectedSize: 1 })).rejects.toBeInstanceOf(ValidationError);
            await expect(client.renameNode(uid, name)).rejects.toBeInstanceOf(ValidationError);
            expect(() => drive.createFile(root.uid, name, { content: bytes('a'), mediaType: 'text/plain', declaredSize: 1 })).toThrow(ValidationError);
        }
        await client.createFolder(root, 'y'.repeat(255));
        expect((await children(root.uid)).map(nameOf).sort()).toEqual(['a.txt', 'y'.repeat(255)]);
    });

    test('another client’s add refuses an empty or too long name, a new folder in the path included', async () => {
        const since = await latestEventId();
        const file = { type: 'file' as const, content: bytes('a') };
        expect(() => drive.add('x'.repeat(256), file)).toThrow(ValidationError);
        expect(() => drive.add(`${'y'.repeat(256)}/f`, file)).toThrow(ValidationError);
        expect(() => drive.add('x'.repeat(256), { type: 'folder' })).toThrow(ValidationError);
        expect(() => drive.add('', file)).toThrow(ValidationError);
        expect(drive.childUids(drive.rootUid)).toEqual([]);
        expect(await events(since)).toEqual([]);
    });

    test('another client’s add of a file over a folder is refused', async () => {
        drive.add('Docs', { type: 'folder' });
        const since = await latestEventId();
        expect(() => drive.add('Docs', { type: 'file', content: bytes('a') })).toThrow(ValidationError);
        expect(drive.nodeAt('Docs')).toMatchObject({ type: 'folder', revisionCount: 0 });
        expect(await events(since)).toEqual([]);
    });

    test('a file holds a v4 node key unless another client adds it with an Argon2-locked one; a folder holds none', async () => {
        drive.add('Photos', { type: 'folder' });
        drive.add('Photos/old.jpg', { type: 'file', content: bytes('a'), nodeKey: 'argon2' });
        drive.add('Photos/new.jpg', { type: 'file', content: bytes('b'), nodeKey: 'v4' });
        drive.add('Photos/plain.jpg', { type: 'file', content: bytes('c') });
        const uploaded = await upload(drive.nodeAt('Photos').uid, 'sdk.jpg', 'd');

        expect(drive.nodeAt('Photos/old.jpg')).toMatchObject({ nodeKey: 'argon2', nodeKeyVersion: 6 });
        expect(drive.nodeAt('Photos/new.jpg')).toMatchObject({ nodeKey: 'v4', nodeKeyVersion: 4 });
        expect(drive.nodeAt('Photos/plain.jpg').nodeKeyVersion).toBe(4);
        expect(drive.nodeAt('Photos/sdk.jpg')).toMatchObject({ uid: uploaded, nodeKeyVersion: 4 });
        expect(drive.nodeAt('Photos').nodeKeyVersion).toBeUndefined();
    });

    test('a file entity gives its node key as encryptedCrypto.armoredKey, and a folder gives none', async () => {
        drive.add('Photos', { type: 'folder' });
        drive.add('Photos/old.jpg', { type: 'file', content: bytes('a'), nodeKey: 'argon2' });
        drive.add('Photos/new.jpg', { type: 'file', content: bytes('b') });

        const armored = async (path: string) => {
            const node = (await client.getNode(drive.nodeAt(path).uid)) as unknown as { encryptedCrypto?: { armoredKey: string } };
            return node.encryptedCrypto?.armoredKey;
        };
        expect(await armored('Photos/old.jpg')).toBe(armoredNodeKey('argon2'));
        expect(await armored('Photos/new.jpg')).toBe(armoredNodeKey('v4'));
        expect(await armored('Photos')).toBeUndefined();
    });

    test('a trash of the root is refused, by another client and through the SDK surface', async () => {
        const root = await client.getMyFilesRootFolder();
        expect(() => drive.trash('')).toThrow(ValidationError);
        const results = [];
        for await (const result of client.trashNodes([root.uid])) results.push(result);
        expect(results).toMatchObject([{ uid: root.uid, ok: false }]);
        expect(!results[0]!.ok && results[0]!.error).toBeInstanceOf(ValidationError);
        expect(drive.trashed()).toEqual([]);
        expect((await client.getMyFilesRootFolder()).trashTime).toBeUndefined();
    });

    test('a rename of the root is refused', async () => {
        const root = await client.getMyFilesRootFolder();
        await expect(client.renameNode(root.uid, 'x')).rejects.toBeInstanceOf(ValidationError);
        expect(nameOf(await client.getMyFilesRootFolder())).toBe('root');
    });

    test('a move of a folder into itself or below itself, or of the root, is refused', async () => {
        const root = await client.getMyFilesRootFolder();
        const a = await client.createFolder(root, 'A');
        const b = await client.createFolder(a, 'B');
        const s = await client.createFolder(root, 'S');
        const docs = await client.createFolder(root, 'Docs');

        const results = [];
        for await (const result of client.moveNodes([a.uid], b)) results.push(result);
        for await (const result of client.moveNodes([s.uid], s)) results.push(result);
        for await (const result of client.moveNodes([root.uid], docs)) results.push(result);
        expect(results.map((r) => r.ok)).toEqual([false, false, false]);
        for (const result of results) expect(!result.ok && result.error).toBeInstanceOf(ValidationError);

        expect(drive.nodeAt('A/B').uid).toBe(b.uid);
        expect(drive.nodeAt('S').uid).toBe(s.uid);
        expect(drive.trashed()).toEqual([]);
    });

    test('an upload whose bytes differ from its declared size fails', async () => {
        const root = await client.getMyFilesRootFolder();
        const uploader = await client.getFileUploader(root, 'a.txt', { mediaType: 'text/plain', expectedSize: 99 });
        const controller = await uploader.uploadFromStream(new Blob(['hello']).stream(), []);
        await expect(controller.completion()).rejects.toBeInstanceOf(IntegrityError);
    });

    test('a file node keeps the claimed time of its upload, as its revision does, and a later upload without one leaves it', async () => {
        const root = await client.getMyFilesRootFolder();
        const claimed = new Date('2001-02-03T04:05:06.000Z');
        const uploader = await client.getFileUploader(root, 'a.txt', { mediaType: 'text/plain', expectedSize: 1, modificationTime: claimed });
        const { nodeUid: uid } = await (await uploader.uploadFromStream(new Blob(['a']).stream(), [])).completion();
        expect(drive.record(uid)?.claimedModificationTime).toBe(claimed.toISOString());
        expect(drive.record(uid)?.revisions.at(-1)?.claimedModificationTime).toBe(claimed.toISOString());

        await overwrite(uid, 'b');
        expect(drive.record(uid)?.claimedModificationTime).toBe(claimed.toISOString());
    });

    test('a revision upload adds a revision and keeps the old one readable', async () => {
        const root = await client.getMyFilesRootFolder();
        const uid = await upload(root.uid, 'a.txt', 'first');
        const revisionUid = await overwrite(uid, 'second version', 'text/x-log');

        const revisions = drive.revisions('a.txt');
        expect(revisions).toHaveLength(2);
        expect(revisions[1]!.uid).toBe(revisionUid);
        expect(revisions.map((r) => r.state)).toEqual(['superseded', 'active']);
        expect(text(drive.content('a.txt', revisions[0]!.uid))).toBe('first');
        expect(text(drive.content('a.txt'))).toBe('second version');
        expect(await download(uid)).toBe('second version');
        const node = await client.getNode(uid);
        expect(node.activeRevision?.uid).toBe(revisionUid);
        expect(node.mediaType).toBe('text/x-log');
    });

    test('a ranged download returns only the bytes in the range', async () => {
        const root = await client.getMyFilesRootFolder();
        const uid = await upload(root.uid, 'a.txt', '0123456789');
        const stream = (await client.getFileDownloader(uid)).getSeekableStream();
        await stream.seek(3);
        const { value, done } = await stream.read(4);
        expect(text(value)).toBe('3456');
        expect(done).toBe(false);
        const rest = await stream.read(100);
        expect(text(rest.value)).toBe('789');
        expect(rest.done).toBe(true);
    });

    test('a seekable stream, read through its own reader after a seek, gives the rest and closes', async () => {
        const root = await client.getMyFilesRootFolder();
        const uid = await upload(root.uid, 'a.txt', '0123456789');
        const stream = (await client.getFileDownloader(uid)).getSeekableStream();
        await stream.seek(3);
        expect(await new Response(stream).text()).toBe('3456789');
    });

    describe('with a block fetch time', () => {
        const BLOCK = 4 * 1024 * 1024;
        const FETCH_MS = 200;

        /** Uploads a file of `blocks` 4 MiB blocks and sets `blockFetchMs` in `drive.json`, as a seed writes it. */
        function slowFile(blocks: number): string {
            const uid = drive.add('big.bin', { type: 'file', content: new Uint8Array(blocks * BLOCK).fill(1) });
            const path = join(dir, 'drive.json');
            writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), blockFetchMs: FETCH_MS }));
            return uid;
        }

        async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
            const began = performance.now();
            const value = await work();
            return { ms: performance.now() - began, value };
        }

        test('a read waits once for each block it fetches, one after the other, and not again for what it kept', async () => {
            const uid = slowFile(3);
            const stream = (await client.getFileDownloader(uid)).getSeekableStream();
            await stream.seek(BLOCK - 10);
            const first = await timed(() => stream.read(BLOCK));
            expect(first.value.value.length).toBe(BLOCK);
            expect(first.ms).toBeGreaterThanOrEqual(2 * FETCH_MS - 5);
            expect(first.ms).toBeLessThan(3 * FETCH_MS);
            const kept = await timed(() => stream.read(10));
            expect(kept.ms).toBeLessThan(FETCH_MS / 2);
        });

        test('a seek back starts again at the block of the new position', async () => {
            const uid = slowFile(2);
            const stream = (await client.getFileDownloader(uid)).getSeekableStream();
            await stream.read(BLOCK + 1);
            await stream.seek(5);
            const again = await timed(() => stream.read(1));
            expect(again.ms).toBeGreaterThanOrEqual(FETCH_MS - 5);
            expect(again.ms).toBeLessThan(2 * FETCH_MS);
        });

        test('streams of one downloader fetch at the same time', async () => {
            const uid = slowFile(4);
            const downloader = await client.getFileDownloader(uid);
            const all = await timed(() =>
                Promise.all([0, 1, 2, 3].map(async (block) => {
                    const stream = downloader.getSeekableStream();
                    await stream.seek(block * BLOCK);
                    return (await stream.read(BLOCK)).value.length;
                })),
            );
            expect(all.value).toEqual([BLOCK, BLOCK, BLOCK, BLOCK]);
            expect(all.ms).toBeLessThan(2 * FETCH_MS);
        });
    });

    test('a seekable stream refuses to read zero or fewer bytes, as the SDK does', async () => {
        const root = await client.getMyFilesRootFolder();
        const uid = await upload(root.uid, 'a.txt', '0123456789');
        const stream = (await client.getFileDownloader(uid)).getSeekableStream();
        await expect(stream.read(0)).rejects.toThrow('Invalid number of bytes to read');
        await expect(stream.read(-1)).rejects.toThrow('Invalid number of bytes to read');
    });

    test('a downloader downloads once: a second download on it throws, as the SDK does', async () => {
        const root = await client.getMyFilesRootFolder();
        const uid = await upload(root.uid, 'a.txt', 'hello');
        const sink = () => new WritableStream<Uint8Array>();
        for (const second of ['downloadToStream', 'unsafeDownloadToStream'] as const) {
            const downloader = await client.getFileDownloader(uid);
            await downloader.downloadToStream(sink()).completion();
            expect(() => downloader[second](sink())).toThrow('Download already started');
        }
        const downloader = await client.getFileDownloader(uid);
        await downloader.unsafeDownloadToStream(sink()).completion();
        expect(() => downloader.downloadToStream(sink())).toThrow('Download already started');
    });

    test('an upload with an aborted signal fails with AbortError and adds no node', async () => {
        const root = await client.getMyFilesRootFolder();
        const abort = new AbortController();
        abort.abort();
        const uploader = await client.getFileUploader(root, 'a.txt', { mediaType: 'text/plain', expectedSize: 1 }, abort.signal);
        const controller = await uploader.uploadFromStream(new Blob(['a']).stream(), []);
        await expect(controller.completion()).rejects.toBeInstanceOf(AbortError);
        expect(drive.childUids(root.uid)).toEqual([]);
    });

    test('a download with an aborted signal fails with AbortError', async () => {
        const root = await client.getMyFilesRootFolder();
        const uid = await upload(root.uid, 'a.txt', 'hello');
        const abort = new AbortController();
        abort.abort();
        const downloader = await client.getFileDownloader(uid, abort.signal);
        await expect(downloader.downloadToStream(new WritableStream()).completion()).rejects.toBeInstanceOf(AbortError);
    });

    test('a trashed node goes to the trash and still comes back from the listing, with its trash time', async () => {
        const root = await client.getMyFilesRootFolder();
        const uid = await upload(root.uid, 'a.txt', 'a');
        for await (const result of client.trashNodes([uid])) expect(result).toEqual({ uid, ok: true });

        expect(drive.trashed().map((n) => n.uid)).toEqual([uid]);
        const [node] = await children(root.uid);
        expect(node!.trashTime).toBeInstanceOf(Date);
        // A new file can take the trashed node's name.
        await upload(root.uid, 'a.txt', 'again');
    });

    test('the nodes the product must hide come back from the SDK surface', async () => {
        const root = await client.getMyFilesRootFolder();
        drive.add('secret.bin', { type: 'file', content: bytes('x'), nameUndecryptable: true });
        drive.add('sizeless.bin', { type: 'file', content: bytes('xyz'), clearTextSize: false });

        const nodes = await children(root.uid);
        const secret = nodes.find((n) => n.uid === drive.nodeAt('secret.bin').uid)!;
        const sizeless = nodes.find((n) => n.uid === drive.nodeAt('sizeless.bin').uid)!;
        expect(secret.name.ok).toBe(false);
        expect(sizeless.activeRevision).toBeDefined();
        expect(sizeless.activeRevision!.claimedSize).toBeUndefined();
        expect((await client.getFileDownloader(sizeless.uid)).getClaimedSizeInBytes()).toBeUndefined();
    });
});

describe('Drive events', () => {
    test('with no last event ID, iterateEvents fast-forwards to the latest event', async () => {
        const [event] = await events();
        expect(event).toMatchObject({ type: DriveEventType.FastForward, treeEventScopeId: SCOPE_ID });
    });

    test('each change another client makes gives one Drive event', async () => {
        const since = await latestEventId();
        const uid = drive.add('Notes/a.txt', { type: 'file', content: bytes('a') });
        const folderUid = drive.nodeAt('Notes').uid;
        drive.rename('Notes/a.txt', 'b.txt');
        drive.trash('Notes/b.txt');

        expect(await events(since)).toMatchObject([
            { type: DriveEventType.NodeCreated, nodeUid: folderUid, isTrashed: false },
            { type: DriveEventType.NodeCreated, nodeUid: uid, parentNodeUid: folderUid, isTrashed: false },
            { type: DriveEventType.NodeUpdated, nodeUid: uid, isTrashed: false },
            { type: DriveEventType.NodeUpdated, nodeUid: uid, isTrashed: true },
        ]);
        expect(drive.trashed().map((n) => n.uid)).toEqual([uid]);
    });

    test('another client’s add of a file that exists gives one NodeUpdated event', async () => {
        const uid = drive.add('a.txt', { type: 'file', content: bytes('a') });
        const since = await latestEventId();
        expect(drive.add('a.txt', { type: 'file', content: bytes('b') })).toBe(uid);
        expect(await events(since)).toMatchObject([{ type: DriveEventType.NodeUpdated, nodeUid: uid }]);
        expect(drive.nodeAt('a.txt').revisionCount).toBe(2);
    });

    test('each change through the SDK surface gives one Drive event', async () => {
        const root = await client.getMyFilesRootFolder();
        const since = await latestEventId();
        const folder = await client.createFolder(root, 'Docs');
        const uid = await upload(root.uid, 'a.txt', 'a');
        await overwrite(uid, 'b');
        await client.renameNode(uid, 'b.txt');
        for await (const _ of client.moveNodes([uid], folder)) void _;
        for await (const _ of client.trashNodes([uid])) void _;

        const got = await events(since);
        expect(got.map((e) => e.type)).toEqual([
            DriveEventType.NodeCreated,
            DriveEventType.NodeCreated,
            DriveEventType.NodeUpdated,
            DriveEventType.NodeUpdated,
            DriveEventType.NodeUpdated,
            DriveEventType.NodeUpdated,
        ]);
        expect(got[4]).toMatchObject({ nodeUid: uid, parentNodeUid: folder.uid });
        expect(await events(got.at(-1)!.eventId)).toEqual([]);
    });

    test('iterateEvents gives no event for a scope that is not the Drive’s', async () => {
        drive.add('a.txt', { type: 'file', content: bytes('a') });
        const out: DriveEvent[] = [];
        for await (const event of client.iterateEvents('volume-2', '0')) out.push(event);
        for await (const event of client.iterateEvents('volume-2')) out.push(event);
        expect(out).toEqual([]);
    });

    test('a scope added two times polls only once', async () => {
        const fired: string[] = [];
        const scheduler = await client.getEventScheduler(async (scope) => void fired.push(scope));
        scheduler.addScope(SCOPE_ID);
        scheduler.addScope(SCOPE_ID);
        expect(fired).toEqual([SCOPE_ID]);
        expect(await client.fireEventScheduler()).toEqual([SCOPE_ID]);
    });

    test('the event scheduler polls when a scope is added, and again each time it is fired', async () => {
        const fired: string[] = [];
        const scheduler = await client.getEventScheduler(async (scope) => void fired.push(scope));
        scheduler.addScope(SCOPE_ID);
        expect(fired).toEqual([SCOPE_ID]);
        expect(await client.fireEventScheduler()).toEqual([SCOPE_ID]);
        expect(fired).toEqual([SCOPE_ID, SCOPE_ID]);
        scheduler.removeScope(SCOPE_ID);
        expect(await client.fireEventScheduler()).toEqual([]);
    });
});

describe('state in DIR', () => {
    test('a Drive opened again on the same DIR has the same paths, node UIDs, revisions, trash and events', async () => {
        const root = await client.getMyFilesRootFolder();
        const folder = await client.createFolder(root, 'Docs');
        const uid = await upload(folder.uid, 'a.txt', 'first');
        await overwrite(uid, 'second');
        const gone = await upload(root.uid, 'gone.txt', 'x');
        for await (const _ of client.trashNodes([gone])) void _;
        const since = await latestEventId();

        const again = FakeDrive.open(dir);
        const againClient = new FakeDriveClient(again);
        expect((await againClient.getMyFilesRootFolder()).uid).toBe(root.uid);
        expect(again.nodeAt('Docs/a.txt').uid).toBe(uid);
        expect(again.revisions('Docs/a.txt')).toEqual(drive.revisions('Docs/a.txt'));
        expect(text(again.content('Docs/a.txt', again.revisions('Docs/a.txt')[0]!.uid))).toBe('first');
        expect(again.trashed().map((n) => n.uid)).toEqual([gone]);

        again.add('b.txt', { type: 'file', content: bytes('b') });
        const after = [];
        for await (const event of againClient.iterateEvents(SCOPE_ID, since)) after.push(event);
        expect(after).toHaveLength(1);
        expect(Number(after[0]!.eventId)).toBeGreaterThan(Number(since));
    });

    test('a DIR whose drive.json has another format does not open', () => {
        const path = join(dir, 'drive.json');
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), format: 2 }));
        expect(() => FakeDrive.open(dir)).toThrow('has format 2, not 1');
    });

    test('two Drives open on one DIR see each other’s changes', async () => {
        const other = FakeDrive.open(dir);
        other.add('Shared/a.txt', { type: 'file', content: bytes('from the other process') });
        expect(text(drive.content('Shared/a.txt'))).toBe('from the other process');
        const root = await client.getMyFilesRootFolder();
        expect((await children(root.uid)).map(nameOf)).toEqual(['Shared']);
    });
});

describe('call counts', () => {
    test('each SDK call adds one to its method, and to its folder, node or download', async () => {
        const root = await client.getMyFilesRootFolder();
        const folder = await client.createFolder(root, 'Docs');
        const uid = await upload(folder.uid, 'a.txt', 'a');
        expect(client.calls()).toEqual({
            methods: { getMyFilesRootFolder: 1, createFolder: 1, getFileUploader: 1, uploadFromStream: 1 },
            listings: {},
            nodeLoads: {},
            downloads: {},
        });

        await children(folder.uid);
        await children(folder.uid);
        await client.getNode(uid);
        await download(uid);

        const calls = client.calls();
        expect(calls.methods).toMatchObject({ iterateFolderChildrenNodeUids: 2, iterateNodes: 2, getNode: 1, getFileDownloader: 1 });
        expect(calls.listings).toEqual({ [folder.uid]: 2 });
        expect(calls.nodeLoads).toEqual({ [uid]: 3 });
        expect(calls.downloads).toEqual({ [uid]: 1 });
    });

    test('every method of the SDK surface is counted', async () => {
        const root = await client.getMyFilesRootFolder();
        const folder = await client.createFolder(root, 'Docs');
        const uid = await upload(root.uid, 'a.txt', 'a');
        await overwrite(uid, 'b');
        await client.renameNode(uid, 'b.txt');
        for await (const _ of client.moveNodes([uid], folder)) void _;
        for await (const _ of client.trashNodes([uid])) void _;
        await client.getEventScheduler(async () => {});
        await events();

        expect(client.calls().methods).toEqual({
            getMyFilesRootFolder: 1,
            createFolder: 1,
            getFileUploader: 1,
            getFileRevisionUploader: 1,
            renameNode: 1,
            moveNodes: 1,
            trashNodes: 1,
            uploadFromStream: 2,
            getEventScheduler: 1,
            iterateEvents: 1,
        });
    });
});

describe('a change that fails', () => {
    test('leaves the Drive as it was', async () => {
        drive.add('a.txt', { type: 'file', content: bytes('a') });
        drive.add('b.txt', { type: 'file', content: bytes('b') });
        const since = await latestEventId();
        expect(() => drive.add('a.txt/New/b.txt', { type: 'file', content: bytes('b') })).toThrow(ValidationError);
        expect(() => drive.add('a.txt', { type: 'folder' })).toThrow(ValidationError);
        expect(() => drive.rename('a.txt', 'b.txt')).toThrow(NodeWithSameNameExistsValidationError);
        expect(drive.nodeAt('a.txt').name).toBe('a.txt');
        expect(await events(since)).toEqual([]);
    });

    test('in its save throws, and leaves the Drive as DIR holds it', async () => {
        const root = await client.getMyFilesRootFolder();
        const since = await latestEventId();
        // A directory where save() writes its temporary file makes the write fail, for root too.
        const blocker = join(dir, `drive.json.${process.pid}.tmp`);
        mkdirSync(blocker);
        await expect(client.createFolder(root, 'Docs')).rejects.toThrow();

        expect(drive.childUids(root.uid)).toEqual([]);
        expect(() => drive.nodeAt('Docs')).toThrow(NoSuchNodeError);
        expect(await events(since)).toEqual([]);
        rmSync(blocker, { recursive: true });
        // The UID the failed change took is free again.
        expect((await client.createFolder(root, 'Docs')).uid).toBe(`${SCOPE_ID}~link-2`);
    });

    test('after it changed the state throws, and leaves the Drive as it was', async () => {
        const since = await latestEventId();
        // add() inserts the folder Docs, then fails to write the file's blob.
        const blob = createHash('sha256').update(bytes('a')).digest('hex');
        mkdirSync(join(dir, 'blobs', `${blob}.${process.pid}.tmp`));
        expect(() => drive.add('Docs/a.txt', { type: 'file', content: bytes('a') })).toThrow();

        expect(drive.childUids(drive.rootUid)).toEqual([]);
        expect(() => drive.nodeAt('Docs')).toThrow(NoSuchNodeError);
        expect(await events(since)).toEqual([]);
    });
});
