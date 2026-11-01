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
