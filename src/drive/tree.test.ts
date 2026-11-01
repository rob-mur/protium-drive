import { describe, expect, test } from 'bun:test';
import { NodeType, type MaybeMissingNode, type NodeEntity, type NodeOrUid } from '@protontech/drive-sdk';

import { DriveTree } from './tree.ts';
import type { DriveSdk } from './sdk.ts';

type Node = NodeEntity;

function folder(uid: string, name: string, parentUid?: string): Node {
    return {
        uid,
        parentUid,
        type: NodeType.Folder,
        name: { ok: true, value: name },
        creationTime: new Date('2026-01-01T00:00:00Z'),
        modificationTime: new Date('2026-01-02T00:00:00Z'),
        treeEventScopeId: 'volume-1',
    } as Node;
}

function file(uid: string, name: string, parentUid: string): Node {
    return {
        uid,
        parentUid,
        type: NodeType.File,
        name: { ok: true, value: name },
        creationTime: new Date('2026-01-01T00:00:00Z'),
        modificationTime: new Date('2026-01-02T00:00:00Z'),
        treeEventScopeId: 'volume-1',
        activeRevision: { uid: `${uid}-rev`, claimedSize: 3, claimedModificationTime: undefined, claimedDigests: {} },
    } as Node;
}

/** The part of the SDK the tree uses, over an in-memory map, with call counts. */
function fakeSdk(nodes: Map<string, Node>) {
    const calls = new Map<string, number>();
    const count = (what: string) => calls.set(what, (calls.get(what) ?? 0) + 1);
    const childrenOf = new Map<string, string[]>();
    for (const node of nodes.values()) {
        if (node.parentUid) {
            childrenOf.set(node.parentUid, [...(childrenOf.get(node.parentUid) ?? []), node.uid]);
        }
    }
    return {
        calls,
        getMyFilesRootFolder: async () => nodes.get('root')!,
        iterateFolderChildrenNodeUids: async function* (parent: NodeOrUid) {
            count('iterateFolderChildrenNodeUids');
            const uid = typeof parent === 'string' ? parent : parent.uid;
            for (const child of childrenOf.get(uid) ?? []) {
                yield child;
            }
        },
        iterateNodes: async function* (uids: NodeOrUid[]) {
            count('iterateNodes');
            for (const uid of uids) {
                yield nodes.get(typeof uid === 'string' ? uid : uid.uid) as MaybeMissingNode;
            }
        },
    } as DriveSdk & { calls: Map<string, number> };
}

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

describe('DriveTree', () => {
    test('the root is My files', async () => {
        const nodes = new Map([[ 'root', folder('root', 'My files') ]]);
        const tree = new DriveTree(fakeSdk(nodes) as never, QUIET);
        const root = await tree.root();
        expect(root).toMatchObject({ uid: 'root', name: 'My files', kind: 'folder' });
    });

    test('an empty Drive lists no children', async () => {
        const nodes = new Map([[ 'root', folder('root', 'My files') ]]);
        const tree = new DriveTree(fakeSdk(nodes) as never, QUIET);
        expect(await tree.list(await tree.root())).toEqual([]);
    });

    test('stat walks the segments below the root, and misses return undefined', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['docs', folder('docs', 'Documents', 'root')],
            ['note', file('note', 'note.txt', 'docs')],
        ]);
        const tree = new DriveTree(fakeSdk(nodes) as never, QUIET);
        expect((await tree.stat(['Documents']))?.uid).toBe('docs');
        expect((await tree.stat(['Documents', 'note.txt']))?.uid).toBe('note');
        expect(await tree.stat(['Documents', 'missing'])).toBeUndefined();
        expect(await tree.stat(['note.txt', 'deeper'])).toBeUndefined();
    });
});

describe('DriveTree trash', () => {
    /** The SDK surface for trashing, recording every call and what it could carry. */
    function fakeTrashSdk(nodes: Map<string, Node>) {
        const base = fakeSdk(nodes);
        const trashed: { uid: string }[] = [];
        let fail: Error | undefined;
        return {
            ...base,
            trashed,
            setFailure: (error: Error) => {
                fail = error;
            },
            trashNodes: async function* (uids: NodeOrUid[]) {
                base.calls.set('trashNodes', (base.calls.get('trashNodes') ?? 0) + 1);
                for (const nodeOrUid of uids) {
                    const uid = typeof nodeOrUid === 'string' ? nodeOrUid : nodeOrUid.uid;
                    if (fail) {
                        yield { uid, ok: false, error: fail };
                        return;
                    }
                    trashed.push({ uid });
                    const node = nodes.get(uid)!;
                    node.trashTime = new Date('2026-02-03T00:00:00Z');
                }
            },
        } as unknown as DriveSdk & typeof base & { trashed: { uid: string }[]; setFailure: (error: Error) => void };
    }

    test('trashing a file hands its UID to Drive and the cached listing forgets it at once', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['beach', file('beach', 'beach.jpg', 'photos')],
        ]);
        const sdk = fakeTrashSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        // Warm the cache so the test proves the forget, not a fresh load.
        expect((await tree.stat(['Photos', 'beach.jpg']))?.uid).toBe('beach');
        const listed = sdk.calls.get('iterateFolderChildrenNodeUids') ?? 0;

        await tree.trash(['Photos', 'beach.jpg']);

        expect(sdk.trashed).toEqual([{ uid: 'beach' }]);
        expect(await tree.stat(['Photos', 'beach.jpg'])).toBeUndefined();
        expect(await tree.list((await tree.stat(['Photos']))!)).toEqual([]);
        // The listing was reloaded exactly once, from Drive, after the trash.
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(listed + 1);
    });

    test('trashing a folder forgets the folder and its parent, and Drive holds nothing under it', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['album', folder('album', 'album', 'photos')],
            ['beach', file('beach', 'beach.jpg', 'album')],
        ]);
        const sdk = fakeTrashSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        expect((await tree.stat(['Photos', 'album', 'beach.jpg']))?.uid).toBe('beach');

        await tree.trash(['Photos', 'album']);

        expect(sdk.trashed).toEqual([{ uid: 'album' }]);
        expect(await tree.stat(['Photos', 'album'])).toBeUndefined();
    });

    test('trashing the root is refused', async () => {
        const nodes = new Map([[ 'root', folder('root', 'My files') ]]);
        const sdk = fakeTrashSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        await expect(tree.trash([])).rejects.toThrow('The root folder cannot be deleted');
        expect(sdk.trashed).toEqual([]);
    });

    test('a path that does not exist is not found', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
        ]);
        const sdk = fakeTrashSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        await expect(tree.trash(['Photos', 'missing.jpg'])).rejects.toThrow('/Photos/missing.jpg not found');
        expect(sdk.trashed).toEqual([]);
    });

    test('a node Drive fails to trash surfaces its error', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['beach', file('beach', 'beach.jpg', 'photos')],
        ]);
        const sdk = fakeTrashSdk(nodes);
        sdk.setFailure(new Error('Drive refused'));
        const tree = new DriveTree(sdk as never, QUIET);
        await expect(tree.trash(['Photos', 'beach.jpg'])).rejects.toThrow('Drive refused');
        expect(sdk.trashed).toEqual([]);
    });
});

describe('DriveTree upload', () => {
    const body = () =>
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('sand and sea'));
                controller.close();
            },
        });

    /** The SDK surface for uploads, recording the metadata each call carried and their order. */
    function fakeUploadSdk(nodes: Map<string, Node>) {
        const base = fakeSdk(nodes);
        const order: string[] = [];
        const uploads: { where: string; metadata: unknown }[] = [];
        const made = new Map<string, Node>();
        const uploader = (where: string) => ({
            uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
                order.push(`upload:${where}`);
                const content = new Uint8Array(await new Response(stream).arrayBuffer());
                const node = structuredClone(
                    [...made.values()].find((n) => n.uid === where) ?? ({} as Node),
                );
                return {
                    pause() {},
                    resume() {},
                    completion: async () => {
                        order.push(`completed:${where}`);
                        return { nodeUid: node.uid ?? where, nodeRevisionUid: `${node.uid ?? where}-rev2` };
                    },
                    // Exposed for the tests: what the stream carried.
                    content,
                };
            },
        });
        return {
            ...base,
            order,
            uploads,
            made,
            getFileUploader: async (parent: NodeOrUid, name: string, metadata: { expectedSize?: number | null }) => {
                order.push('getFileUploader');
                uploads.push({ where: `create in ${typeof parent === 'string' ? parent : parent.uid} as ${name}`, metadata });
                const uid = `new-${name}`;
                made.set(uid, file(uid, name, typeof parent === 'string' ? parent : parent.uid));
                return uploader(uid);
            },
            getFileRevisionUploader: async (uid: NodeOrUid, metadata: { expectedSize?: number | null }) => {
                order.push('getFileRevisionUploader');
                const nodeUid = typeof uid === 'string' ? uid : uid.uid;
                uploads.push({ where: `revise ${nodeUid}`, metadata });
                return uploader(nodeUid);
            },
            getNode: async (uid: NodeOrUid) => {
                order.push('getNode');
                const key = typeof uid === 'string' ? uid : uid.uid;
                return made.get(key) ?? nodes.get(key)!;
            },
            // The made nodes exist for the next listing too, as Drive would show them.
            iterateFolderChildrenNodeUids: async function* (parent: NodeOrUid) {
                const pid = typeof parent === 'string' ? parent : parent.uid;
                for await (const uid of base.iterateFolderChildrenNodeUids(pid)) {
                    yield uid;
                }
                for (const node of made.values()) {
                    if (node.parentUid === pid) {
                        yield node.uid;
                    }
                }
            },
            iterateNodes: async function* (uids: NodeOrUid[]) {
                for (const uid of uids) {
                    const key = typeof uid === 'string' ? uid : uid.uid;
                    yield made.get(key) ?? nodes.get(key) as MaybeMissingNode;
                }
            },
        } as unknown as DriveSdk & typeof base & { order: string[]; uploads: typeof uploads; made: Map<string, Node> };
    }

    test('a new name creates a file with the metadata the request declared', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
        ]);
        const sdk = fakeUploadSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        const photos = (await tree.stat(['Photos']))!;
        const { entry, created } = await tree.upload(['Photos'], 'beach.jpg', body(), {
            size: 12,
            mediaType: 'image/jpeg',
        });
        expect(created).toBe(true);
        expect(entry).toMatchObject({ uid: 'new-beach.jpg', name: 'beach.jpg', kind: 'file' });
        expect(sdk.order[0]).toBe('getFileUploader');
        expect(sdk.uploads[0]).toEqual({
            where: 'create in photos as beach.jpg',
            metadata: { expectedSize: 12, mediaType: 'image/jpeg' },
        });
    });

    test('an existing file gets a revision uploader instead', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['beach', file('beach', 'beach.jpg', 'photos')],
        ]);
        const sdk = fakeUploadSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        const { created } = await tree.upload(['Photos'], 'beach.jpg', body(), {
            size: 12,
            mediaType: 'image/jpeg',
        });
        expect(created).toBe(false);
        expect(sdk.order[0]).toBe('getFileRevisionUploader');
        expect(sdk.uploads[0]?.metadata).toEqual({ expectedSize: 12, mediaType: 'image/jpeg' });
    });

    test('uploading into a name that is a folder is refused', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['album', folder('album', 'album', 'photos')],
        ]);
        const sdk = fakeUploadSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        await expect(tree.upload(['Photos'], 'album', body(), { size: 12, mediaType: 'image/jpeg' })).rejects.toThrow(
            'album is a folder',
        );
    });

    test('a listing that held the file before the upload shows it after', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
        ]);
        const sdk = fakeUploadSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        const photos = (await tree.stat(['Photos']))!;
        expect(await tree.list(photos)).toEqual([]);
        await tree.upload(['Photos'], 'beach.jpg', body(), { size: 12, mediaType: 'image/jpeg' });
        expect((await tree.stat(['Photos', 'beach.jpg']))?.uid).toBe('new-beach.jpg');
    });
});

describe('DriveTree listing cache', () => {
    test('a folder is listed once, however many clients ask', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['beach', file('beach', 'beach.jpg', 'photos')],
        ]);
        const sdk = fakeSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        const photos = (await tree.stat(['Photos']))!;
        expect((await tree.list(photos)).map((entry) => entry.name)).toEqual(['beach.jpg']);

        const listed = sdk.calls.get('iterateFolderChildrenNodeUids') ?? 0;
        // A stat through Photos, another listing of Photos, and a Depth 1-style stat all reuse the cache.
        expect((await tree.stat(['Photos', 'beach.jpg']))?.uid).toBe('beach');
        await tree.list(photos);
        await tree.list(photos);
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(listed);
    });

    test('the listing loads only when a client asks, never on its own', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['docs', folder('docs', 'Documents', 'root')],
            ['note', file('note', 'note.txt', 'docs')],
        ]);
        const sdk = fakeSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        await tree.root();
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBeUndefined();
    });

    test('a listing that fails is not cached, so the next ask loads it again', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['docs', folder('docs', 'Documents', 'root')],
            ['note', file('note', 'note.txt', 'docs')],
        ]);
        const sdk = fakeSdk(nodes);
        let fail = true;
        sdk.iterateFolderChildrenNodeUids = (async function* (parent: NodeOrUid) {
            const uid = typeof parent === 'string' ? parent : parent.uid;
            sdk.calls.set('iterateFolderChildrenNodeUids', (sdk.calls.get('iterateFolderChildrenNodeUids') ?? 0) + 1);
            if (fail && uid === 'docs') {
                throw new Error('Proton unreachable');
            }
            for (const uid_ of (nodes.values()).filter((n) => n.parentUid === uid).map((n) => n.uid)) {
                yield uid_;
            }
        }) as typeof sdk.iterateFolderChildrenNodeUids;
        const tree = new DriveTree(sdk as never, QUIET);
        const docs = (await tree.stat(['Documents']))!;
        await expect(tree.list(docs)).rejects.toThrow('Proton unreachable');

        fail = false;
        expect((await tree.list(docs)).map((entry) => entry.name)).toEqual(['note.txt']);
        expect((await tree.stat(['Documents', 'note.txt']))?.uid).toBe('note');
    });

    test('asks that arrive together share one load of the folder', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['beach', file('beach', 'beach.jpg', 'photos')],
        ]);
        const sdk = fakeSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        const photos = (await tree.stat(['Photos']))!;
        const listedBefore = sdk.calls.get('iterateFolderChildrenNodeUids');
        const [entriesA, entriesB, stat] = await Promise.all([
            tree.list(photos),
            tree.list(photos),
            tree.stat(['Photos', 'beach.jpg']),
        ]);
        expect(entriesA.map((entry) => entry.name)).toEqual(['beach.jpg']);
        expect(entriesB.map((entry) => entry.name)).toEqual(['beach.jpg']);
        expect(stat?.uid).toBe('beach');
        // The three asks together load Photos exactly once.
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(listedBefore! + 1);
    });
});
