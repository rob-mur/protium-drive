import { describe, expect, test } from 'bun:test';
import { AbortError, NodeType, type MaybeMissingNode, type NodeEntity, type NodeOrUid, RateLimitedError } from '@protontech/drive-sdk';

import { createTelemetry } from '../logger.ts';
import { Backoff } from './backoff.ts';
import { DriveTree, UPLOAD_STALL_MS } from './tree.ts';
import type { ListingSnapshot } from './listing-cache.ts';
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
                const key = typeof uid === 'string' ? uid : uid.uid;
                // A UID the node map does not hold comes back as a missing node.
                yield (nodes.get(key) ?? { missingUid: key }) as MaybeMissingNode;
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

describe('DriveTree root path', () => {
    /** The fixture the scenarios describe: My files with Photos/immich/beach.jpg and Documents/cv.pdf. */
    function fixture(): Map<string, Node> {
        return new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['immich', folder('immich', 'immich', 'photos')],
            ['beach', file('beach', 'beach.jpg', 'immich')],
            ['docs', folder('docs', 'Documents', 'root')],
            ['cv', file('cv', 'cv.pdf', 'docs')],
        ]);
    }

    test('a root path serves that folder as the root, and paths are relative to it', async () => {
        const tree = new DriveTree(fakeSdk(fixture()) as never, QUIET, undefined, { rootPath: ['Photos', 'immich'] });
        const root = await tree.root();
        expect(root).toMatchObject({ uid: 'immich', name: 'immich', kind: 'folder' });
        expect((await tree.stat([]))?.uid).toBe('immich');
        expect((await tree.stat(['beach.jpg']))?.uid).toBe('beach');
        expect(await tree.stat(['Documents', 'cv.pdf'])).toBeUndefined();
        expect((await tree.list(root)).map((entry) => entry.name)).toEqual(['beach.jpg']);
    });

    test('a missing root folder fails the first ask naming the folder', async () => {
        const nodes = fixture();
        nodes.delete('immich'); // My files holds Photos but not its immich folder
        const missing = new DriveTree(fakeSdk(nodes) as never, QUIET, undefined, { rootPath: ['Photos', 'immich'] });
        await expect(missing.root()).rejects.toThrow('Root folder /Photos/immich does not exist in My files');
        await expect(missing.stat([])).rejects.toThrow('Root folder /Photos/immich does not exist in My files');
    });

    test('a root path that names a file fails naming the folder', async () => {
        const tree = new DriveTree(fakeSdk(fixture()) as never, QUIET, undefined, { rootPath: ['Photos', 'immich', 'beach.jpg'] });
        await expect(tree.root()).rejects.toThrow('Root folder /Photos/immich/beach.jpg does not exist in My files');
    });

    test('a failed root lookup is not cached, so the next ask loads it again', async () => {
        const nodes = fixture();
        const sdk = fakeSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET, undefined, { rootPath: ['Photos', 'immich'] });
        nodes.delete('immich');
        await expect(tree.root()).rejects.toThrow('Root folder /Photos/immich does not exist in My files');
        nodes.set('immich', folder('immich', 'immich', 'photos'));
        expect((await tree.root()).uid).toBe('immich');
    });

    test('the watcher scope travels with the served root, not with My files', async () => {
        const nodes = fixture();
        (nodes.get('immich') as Node).treeEventScopeId = 'immich-scope';
        const tree = new DriveTree(fakeSdk(nodes) as never, QUIET, undefined, { rootPath: ['Photos', 'immich'] });
        expect((await tree.root()).treeEventScopeId).toBe('immich-scope');
    });
});

describe('DriveTree unservable nodes', () => {
    /** A logger that records what the tree warns and debugs about. */
    function recordingLogger() {
        const warnings: string[] = [];
        return { warnings, debug() {}, info() {}, warn(message: string) { warnings.push(message); }, error() {} };
    }

    /** A fixture folder holding a healthy file plus one unservable sibling. */
    function fixtureWith(sibling: Node): Map<string, Node> {
        return new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['beach', file('beach', 'beach.jpg', 'photos')],
            [sibling.uid, sibling],
        ]);
    }

    test('a trashed sibling is not listed and draws no warning', async () => {
        const trashed = file('old', 'old.jpg', 'photos');
        trashed.trashTime = new Date('2026-02-03T00:00:00Z');
        const logger = recordingLogger();
        const tree = new DriveTree(fakeSdk(fixtureWith(trashed)) as never, logger);
        const listed = await tree.list((await tree.stat(['Photos']))!);
        expect(listed.map((entry) => entry.name)).toEqual(['beach.jpg']);
        expect(logger.warnings).toEqual([]);
    });

    test('a sibling whose name cannot be decrypted is not listed and draws a warning', async () => {
        const undecryptable = file('hidden', 'hidden.jpg', 'photos');
        undecryptable.name = { ok: false, error: new Error('cannot decrypt') };
        const logger = recordingLogger();
        const tree = new DriveTree(fakeSdk(fixtureWith(undecryptable)) as never, logger);
        const listed = await tree.list((await tree.stat(['Photos']))!);
        expect(listed.map((entry) => entry.name)).toEqual(['beach.jpg']);
        expect(logger.warnings).toEqual([expect.stringContaining('hidden')]);
    });

    test('a sibling with no clear-text size is not listed and draws a warning', async () => {
        const unsized = file('odd', 'odd.jpg', 'photos');
        (unsized.activeRevision as { claimedSize?: number }).claimedSize = undefined;
        const logger = recordingLogger();
        const tree = new DriveTree(fakeSdk(fixtureWith(unsized)) as never, logger);
        const listed = await tree.list((await tree.stat(['Photos']))!);
        expect(listed.map((entry) => entry.name)).toEqual(['beach.jpg']);
        expect(logger.warnings).toEqual([expect.stringContaining('odd')]);
    });

    test('a node that comes back missing is skipped without a warning', async () => {
        const logger = recordingLogger();
        const nodes = fixtureWith(file('ghost', 'ghost.jpg', 'photos'));
        nodes.delete('ghost'); // the SDK yields only its missingUid for it
        const tree = new DriveTree(fakeSdk(nodes) as never, logger);
        const listed = await tree.list((await tree.stat(['Photos']))!);
        expect(listed.map((entry) => entry.name)).toEqual(['beach.jpg']);
        expect(logger.warnings).toEqual([]);
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

    test('an upload into a listed folder adds the file to the listing, and the folder is not listed again', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['beach', file('beach', 'beach.jpg', 'photos')],
        ]);
        const sdk = fakeUploadSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        await tree.list((await tree.stat(['Photos']))!);
        const listed = sdk.calls.get('iterateFolderChildrenNodeUids');
        await tree.upload(['Photos'], 'snow.jpg', body(), { size: 12, mediaType: 'image/jpeg' });
        await tree.upload(['Photos'], 'beach.jpg', body(), { size: 12, mediaType: 'image/jpeg' });
        expect((await tree.stat(['Photos', 'snow.jpg']))?.uid).toBe('new-snow.jpg');
        expect((await tree.list((await tree.stat(['Photos']))!)).map((entry) => entry.name).sort()).toEqual(['beach.jpg', 'snow.jpg']);
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(listed);
    });

    test('a listing that started loading while an upload was on its way is dropped, so the next ask lists the folder again', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
        ]);
        const sdk = fakeUploadSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        const photos = (await tree.stat(['Photos']))!;
        await tree.list(photos);
        let uploaded!: () => void;
        const uploadGate = new Promise<void>((resolve) => (uploaded = resolve));
        const getFileUploader = sdk.getFileUploader;
        sdk.getFileUploader = (async (...args: Parameters<typeof getFileUploader>) => {
            await uploadGate;
            return getFileUploader(...args);
        }) as never;
        let listed!: () => void;
        const listGate = new Promise<void>((resolve) => (listed = resolve));
        const iterate = sdk.iterateFolderChildrenNodeUids;
        sdk.iterateFolderChildrenNodeUids = async function* (parent: NodeOrUid) {
            await listGate;
            yield* iterate(parent);
        } as never;
        const upload = tree.upload(['Photos'], 'snow.jpg', body(), { size: 12, mediaType: 'image/jpeg' });
        await Bun.sleep(0);
        // An event drops the listing while the upload is on its way, and a client asks again.
        tree.dropListings(['photos']);
        const loading = tree.list(photos);
        uploaded();
        await upload;
        listed();
        await loading;
        const before = sdk.calls.get('iterateFolderChildrenNodeUids') ?? 0;
        expect((await tree.stat(['Photos', 'snow.jpg']))?.uid).toBe('new-snow.jpg');
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(before + 1);
    });
});

describe('DriveTree upload that moves no bytes', () => {
    const nodes = () =>
        new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
        ]);
    const body = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });

    /** Timers that fire only when a test fires them. */
    function manualTimers() {
        const pending = new Map<number, { callback: () => unknown; ms: number }>();
        let next = 0;
        return {
            pending,
            setTimeout: (callback: () => unknown, ms: number) => {
                pending.set(++next, { callback, ms });
                return next;
            },
            clearTimeout: (handle: never) => void pending.delete(handle as number),
            /** Fires the one pending timer. */
            fire() {
                expect(pending.size).toBe(1);
                const [handle, timer] = [...pending][0]!;
                pending.delete(handle);
                timer.callback();
            },
            /** Fires the pending timer `handle`. */
            fireHandle(handle: number) {
                const timer = pending.get(handle);
                expect(timer).toBeDefined();
                pending.delete(handle);
                timer!.callback();
            },
        };
    }

    /**
     * An SDK whose upload reports progress when the test calls `progress`, and finishes when it
     * calls `finish`. It fails with AbortError once the signal it was given aborts, unless
     * `ignoresAbort`, when it never ends on its own.
     */
    function stallingSdk(ignoresAbort = false) {
        const base = fakeSdk(nodes());
        const made = file('new-beach.jpg', 'beach.jpg', 'photos');
        const state = {
            signal: undefined as AbortSignal | undefined,
            progress: (_bytes: number) => {},
            finish: () => {},
            started: false,
        };
        const uploader = (signal?: AbortSignal) => {
            state.signal = signal;
            return {
                uploadFromStream: async (_stream: ReadableStream, _thumbnails: unknown, onProgress?: (bytes: number) => void) => {
                    state.started = true;
                    state.progress = (bytes) => onProgress?.(bytes);
                    const done = new Promise<{ nodeUid: string; nodeRevisionUid: string }>((resolve, reject) => {
                        state.finish = () => resolve({ nodeUid: made.uid, nodeRevisionUid: 'rev' });
                        if (!ignoresAbort) {
                            signal?.addEventListener('abort', () => reject(new AbortError('upload aborted')), { once: true });
                        }
                    });
                    done.catch(() => {});
                    return { pause() {}, resume() {}, completion: () => done };
                },
            };
        };
        const sdk = {
            ...base,
            getFileUploader: async (_parent: NodeOrUid, _name: string, _metadata: unknown, signal?: AbortSignal) => uploader(signal),
            getNode: async () => made,
        } as unknown as DriveSdk;
        return { sdk, state };
    }

    /** Waits until the upload has started, as the SDK sees it. */
    async function started(state: { started: boolean }) {
        for (let i = 0; i < 100 && !state.started; i++) await Promise.resolve();
        expect(state.started).toBe(true);
    }

    test('waits four minutes, inside the five-minute timeout rclone has by default', () => {
        expect(UPLOAD_STALL_MS).toBe(4 * 60 * 1000);
    });

    test('an upload that moves no bytes for the stall time is aborted, and fails as a gateway timeout', async () => {
        const timers = manualTimers();
        const { sdk, state } = stallingSdk();
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        const upload = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' });
        await started(state);
        expect([...timers.pending.values()].map((timer) => timer.ms)).toEqual([UPLOAD_STALL_MS]);
        timers.fire();
        expect(state.signal?.aborted).toBe(true);
        await expect(upload).rejects.toMatchObject({ name: 'DriveError', status: 504 });
        expect(timers.pending.size).toBe(0);
    });

    test('an upload whose SDK ignores the abort still fails at once', async () => {
        const timers = manualTimers();
        const { sdk, state } = stallingSdk(true);
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        const upload = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' });
        await started(state);
        timers.fire();
        await expect(upload).rejects.toMatchObject({ name: 'DriveError', status: 504 });
    });

    test('each report of progress starts the stall time again, and a finished upload leaves no timer', async () => {
        const timers = manualTimers();
        const { sdk, state } = stallingSdk();
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        const upload = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' });
        await started(state);
        const first = [...timers.pending.keys()];
        state.progress(4 * 1024 * 1024);
        const second = [...timers.pending.keys()];
        expect(second).toHaveLength(1);
        expect(second).not.toEqual(first);
        expect(timers.pending.get(second[0]!)?.ms).toBe(UPLOAD_STALL_MS);
        state.finish();
        const { entry } = await upload;
        expect(entry.name).toBe('beach.jpg');
        expect(state.signal?.aborted).toBe(false);
        expect(timers.pending.size).toBe(0);
    });

    test('a client that goes away aborts the upload as before, not as a gateway timeout', async () => {
        const timers = manualTimers();
        const { sdk, state } = stallingSdk();
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        const client = new AbortController();
        const upload = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' }, client.signal);
        await started(state);
        client.abort();
        expect(state.signal?.aborted).toBe(true);
        await expect(upload).rejects.toBeInstanceOf(AbortError);
        expect(timers.pending.size).toBe(0);
    });

    /**
     * The stalling SDK, but its `getFileUploader` and `getFileRevisionUploader` hand back the
     * uploader only when the test calls `give`, as when the SDK's upload queue is full. The wait
     * fails with AbortError once its signal aborts, unless `ignoresAbort`.
     */
    function waitingSdk(ignoresAbort = false) {
        const { sdk, state } = stallingSdk();
        const wait = { asked: false, give: () => {} };
        const held = <T>(signal: AbortSignal | undefined, uploader: () => Promise<T>) =>
            new Promise<T>((resolve, reject) => {
                wait.asked = true;
                wait.give = () => void uploader().then(resolve, reject);
                if (!ignoresAbort) {
                    signal?.addEventListener('abort', () => reject(new AbortError('waiting aborted')), { once: true });
                }
            });
        const waiting = {
            ...sdk,
            getFileUploader: (parent: NodeOrUid, name: string, metadata: unknown, signal?: AbortSignal) =>
                held(signal, () => sdk.getFileUploader(parent, name, metadata as never, signal)),
            getFileRevisionUploader: (uid: NodeOrUid, metadata: unknown, signal?: AbortSignal) =>
                held(signal, () => sdk.getFileUploader('photos', 'beach.jpg', metadata as never, signal)),
        } as unknown as DriveSdk;
        return { sdk: waiting, state, wait };
    }

    /** Waits until the upload has asked the SDK for an uploader. */
    async function asked(wait: { asked: boolean }) {
        for (let i = 0; i < 100 && !wait.asked; i++) await Promise.resolve();
        expect(wait.asked).toBe(true);
    }

    test('an upload that waits the stall time for an uploader is aborted, and fails as a gateway timeout with the stall message', async () => {
        const timers = manualTimers();
        const { sdk, state, wait } = waitingSdk();
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        const upload = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' });
        await asked(wait);
        expect([...timers.pending.values()].map((timer) => timer.ms)).toEqual([UPLOAD_STALL_MS]);
        timers.fire();
        expect(state.signal).toBeUndefined();
        await expect(upload).rejects.toMatchObject({
            name: 'DriveError',
            status: 504,
            message: `beach.jpg moved no bytes for ${UPLOAD_STALL_MS / 1000}s, so its upload was aborted`,
        });
        expect(state.started).toBe(false);
        expect(timers.pending.size).toBe(0);
    });

    test('a new revision that waits the stall time for an uploader fails as a gateway timeout too', async () => {
        const timers = manualTimers();
        const { sdk, wait } = waitingSdk();
        const existing = new Map([...nodes(), ['beach', file('beach', 'beach.jpg', 'photos')]]);
        const tree = new DriveTree({ ...fakeSdk(existing), getFileRevisionUploader: sdk.getFileRevisionUploader } as unknown as DriveSdk, QUIET, new Backoff(), timers);
        const upload = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' });
        await asked(wait);
        timers.fire();
        await expect(upload).rejects.toMatchObject({ name: 'DriveError', status: 504 });
    });

    test('a wait for an uploader that ignores the abort still fails at once', async () => {
        const timers = manualTimers();
        const { sdk, wait } = waitingSdk(true);
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        const upload = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' });
        await asked(wait);
        timers.fire();
        await expect(upload).rejects.toMatchObject({ name: 'DriveError', status: 504 });
    });

    test('an upload that gets its uploader in time gets the whole stall time again, and makes progress as before', async () => {
        const timers = manualTimers();
        const { sdk, state, wait } = waitingSdk();
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        const upload = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' });
        await asked(wait);
        const waiting = [...timers.pending.keys()];
        wait.give();
        await started(state);
        const uploading = [...timers.pending.keys()];
        expect(uploading).toHaveLength(1);
        expect(uploading).not.toEqual(waiting);
        expect(timers.pending.get(uploading[0]!)?.ms).toBe(UPLOAD_STALL_MS);
        state.progress(4 * 1024 * 1024);
        state.finish();
        const { entry } = await upload;
        expect(entry.name).toBe('beach.jpg');
        expect(state.signal?.aborted).toBe(false);
        expect(timers.pending.size).toBe(0);
    });

    /** A logger that records each line as `level: message error`. */
    function recordingLogger() {
        const lines: string[] = [];
        const at = (level: string) => (message: string, ...args: unknown[]) =>
            void lines.push([`${level}: ${message}`, ...args.map(String)].join(' '));
        return { lines, logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } };
    }

    /**
     * An SDK whose uploads log through pdm's telemetry as the real SDK does: each upload awaits
     * its end and, when that fails, logs `Upload failed` with the error at error level. An
     * upload fails with `AbortError` once its signal aborts, or with `fail(name, error)`.
     */
    function loggingSdk(telemetry: ReturnType<typeof createTelemetry>) {
        const sdkLogger = telemetry.getLogger('upload');
        const base = fakeSdk(nodes());
        const uploads = new Map<string, { fail: (error: unknown) => void }>();
        const uploader = (name: string, signal?: AbortSignal) => ({
            uploadFromStream: async () => {
                let fail!: (error: unknown) => void;
                const done = new Promise<never>((_resolve, reject) => (fail = reject));
                signal?.addEventListener('abort', () => fail(new AbortError('Request aborted')), { once: true });
                uploads.set(name, { fail });
                const completion = (async () => {
                    try {
                        return await done;
                    } catch (error) {
                        sdkLogger.error('Upload failed', error);
                        throw error;
                    }
                })();
                completion.catch(() => {});
                return { pause() {}, resume() {}, completion: () => completion };
            },
        });
        const sdk = {
            ...base,
            getFileUploader: async (_parent: NodeOrUid, name: string, _metadata: unknown, signal?: AbortSignal) =>
                uploader(name, signal),
        } as unknown as DriveSdk;
        return { sdk, uploads };
    }

    async function startedUpload(uploads: Map<string, unknown>, name: string) {
        for (let i = 0; i < 100 && !uploads.has(name); i++) await Promise.resolve();
        expect(uploads.has(name)).toBe(true);
    }

    test('an upload the client aborts, as rclone does at stop, logs Upload failed at warn in the same words', async () => {
        const { lines, logger } = recordingLogger();
        const { sdk, uploads } = loggingSdk(createTelemetry(logger));
        const tree = new DriveTree(sdk, QUIET, new Backoff());
        const client = new AbortController();
        const upload = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' }, client.signal);
        await startedUpload(uploads, 'beach.jpg');
        client.abort();
        await expect(upload).rejects.toBeInstanceOf(AbortError);
        expect(lines).toEqual(['warn: [upload] Upload failed AbortError: Request aborted']);
    });

    test('an upload that pdm aborts at a stall still logs at error, and fails as a gateway timeout', async () => {
        const { lines, logger } = recordingLogger();
        const { sdk, uploads } = loggingSdk(createTelemetry(logger));
        const timers = manualTimers();
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        const upload = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' }, new AbortController().signal);
        await startedUpload(uploads, 'beach.jpg');
        timers.fire();
        await expect(upload).rejects.toMatchObject({ name: 'DriveError', status: 504 });
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(lines).toEqual(['error: [upload] Upload failed AbortError: Request aborted']);
    });

    test('a stall abort stays an error when the client aborts after the stall, before the SDK logs', async () => {
        const { lines, logger } = recordingLogger();
        const { sdk, uploads } = loggingSdk(createTelemetry(logger));
        const timers = manualTimers();
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        const client = new AbortController();
        const upload = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' }, client.signal);
        await startedUpload(uploads, 'beach.jpg');
        timers.fire();
        // The client drops the connection after the 504, as Go's http client does.
        client.abort();
        await expect(upload).rejects.toMatchObject({ name: 'DriveError', status: 504 });
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(lines).toEqual(['error: [upload] Upload failed AbortError: Request aborted']);
    });

    test('two uploads at once keep apart: a client abort on one leaves the other failing at error', async () => {
        const { lines, logger } = recordingLogger();
        const { sdk, uploads } = loggingSdk(createTelemetry(logger));
        const tree = new DriveTree(sdk, QUIET, new Backoff());
        const client = new AbortController();
        const aborted = tree.upload(['Photos'], 'beach.jpg', body(), { mediaType: 'image/jpeg' }, client.signal);
        const failed = tree.upload(['Photos'], 'dunes.jpg', body(), { mediaType: 'image/jpeg' }, new AbortController().signal);
        await startedUpload(uploads, 'beach.jpg');
        await startedUpload(uploads, 'dunes.jpg');
        client.abort();
        uploads.get('dunes.jpg')!.fail(new AbortError('Request aborted'));
        const [one, other] = await Promise.allSettled([aborted, failed]);
        expect(one).toMatchObject({ status: 'rejected', reason: expect.any(AbortError) });
        expect(other).toMatchObject({ status: 'rejected', reason: expect.any(AbortError) });
        expect(lines).toEqual([
            'warn: [upload] Upload failed AbortError: Request aborted',
            'error: [upload] Upload failed AbortError: Request aborted',
        ]);
    });

    /**
     * An SDK whose uploader for each file name waits until the test calls `give`, as when the
     * SDK's upload queue is full. A given upload reports a block on `progress`, and ends on
     * `finish` or `fail`. Both the wait and the upload fail with AbortError once the signal aborts.
     */
    function queueSdk() {
        const base = fakeSdk(nodes());
        type Held = { give(): void; progress(): void; finish(): void; fail(): void; started: boolean };
        const uploads = new Map<string, Held>();
        const sdk = {
            ...base,
            getFileUploader: (_parent: NodeOrUid, name: string, _metadata: unknown, signal?: AbortSignal) =>
                new Promise((resolve, reject) => {
                    const upload: Held = { give() {}, progress() {}, finish() {}, fail() {}, started: false };
                    uploads.set(name, upload);
                    signal?.addEventListener('abort', () => reject(new AbortError('waiting aborted')), { once: true });
                    upload.give = () =>
                        resolve({
                            uploadFromStream: async (_stream: ReadableStream, _thumbnails: unknown, onProgress?: (bytes: number) => void) => {
                                upload.started = true;
                                const done = new Promise((resolveDone, rejectDone) => {
                                    upload.progress = () => onProgress?.(4 * 1024 * 1024);
                                    upload.finish = () => resolveDone({ nodeUid: `new-${name}`, nodeRevisionUid: 'rev' });
                                    upload.fail = () => rejectDone(new Error('upload failed'));
                                    signal?.addEventListener('abort', () => rejectDone(new AbortError('upload aborted')), { once: true });
                                });
                                done.catch(() => {});
                                return { pause() {}, resume() {}, completion: () => done };
                            },
                        });
                }),
            getNode: async (uid: string) => file(uid, uid.replace(/^new-/, ''), 'photos'),
        } as unknown as DriveSdk;
        /** Waits until `name` has asked for its uploader. */
        const asked = async (name: string) => {
            for (let i = 0; i < 100 && !uploads.has(name); i++) await Promise.resolve();
            expect(uploads.has(name)).toBe(true);
            return uploads.get(name)!;
        };
        return { sdk, asked };
    }

    const write = (tree: DriveTree, name: string) => tree.upload(['Photos'], name, body(), { mediaType: 'image/jpeg' });

    /** The handle of the one stall timer armed while `step` ran. */
    async function armedBy(timers: ReturnType<typeof manualTimers>, step: () => Promise<unknown>) {
        const before = new Set(timers.pending.keys());
        await step();
        const armed = [...timers.pending.keys()].filter((handle) => !before.has(handle));
        expect(armed).toHaveLength(1);
        return armed[0]!;
    }

    test('an upload that waits for an uploader gets the whole stall time again each time another upload gets its uploader, moves bytes or ends', async () => {
        const timers = manualTimers();
        const { sdk, asked } = queueSdk();
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        const beach = write(tree, 'beach.jpg');
        const beachUpload = await asked('beach.jpg');
        let dunes!: ReturnType<typeof write>;
        let waiting = await armedBy(timers, async () => {
            dunes = write(tree, 'dunes.jpg');
            await asked('dunes.jpg');
        });
        const moves = async (step: () => Promise<unknown> | void) => {
            await step();
            expect(timers.pending.has(waiting)).toBe(false);
            const now = [...timers.pending.keys()].at(-1)!;
            expect(timers.pending.get(now)?.ms).toBe(UPLOAD_STALL_MS);
            waiting = now;
        };
        await moves(async () => {
            beachUpload.give();
            await started(beachUpload);
        });
        await moves(() => beachUpload.progress());
        await moves(async () => {
            beachUpload.finish();
            await beach;
        });
        expect(timers.pending.size).toBe(1);
        const dunesUpload = await asked('dunes.jpg');
        dunesUpload.give();
        await started(dunesUpload);
        dunesUpload.finish();
        expect((await dunes).entry.name).toBe('dunes.jpg');
        expect(timers.pending.size).toBe(0);
    });

    test('an upload that waits behind a stalled upload outlives its abort: the abort restarts its stall time at once', async () => {
        const timers = manualTimers();
        const { sdk, asked } = queueSdk();
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        let beach!: ReturnType<typeof write>;
        const stalled = await armedBy(timers, async () => {
            beach = write(tree, 'beach.jpg');
            const upload = await asked('beach.jpg');
            upload.give();
            await started(upload);
        });
        let dunes!: ReturnType<typeof write>;
        const waiting = await armedBy(timers, async () => {
            dunes = write(tree, 'dunes.jpg');
            await asked('dunes.jpg');
        });
        timers.fireHandle(stalled);
        // At once, before any await: a timer due at the same moment must not fire first.
        expect(timers.pending.has(waiting)).toBe(false);
        expect(timers.pending.size).toBe(1);
        await expect(beach).rejects.toMatchObject({ name: 'DriveError', status: 504 });
        const dunesUpload = await asked('dunes.jpg');
        dunesUpload.give();
        await started(dunesUpload);
        dunesUpload.finish();
        expect((await dunes).entry.name).toBe('dunes.jpg');
        expect(timers.pending.size).toBe(0);
    });

    test('an upload that fails gives the uploads waiting behind it the whole stall time again', async () => {
        const timers = manualTimers();
        const { sdk, asked } = queueSdk();
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        const beach = write(tree, 'beach.jpg');
        const beachUpload = await asked('beach.jpg');
        beachUpload.give();
        await started(beachUpload);
        const waiting = await armedBy(timers, async () => {
            void write(tree, 'dunes.jpg').catch(() => {});
            await asked('dunes.jpg');
        });
        beachUpload.fail();
        await expect(beach).rejects.toThrow('upload failed');
        expect(timers.pending.has(waiting)).toBe(false);
        expect(timers.pending.size).toBe(1);
    });

    test('uploads that all wait, with nothing moving, are each aborted at the stall time', async () => {
        const timers = manualTimers();
        const { sdk, asked } = queueSdk();
        const tree = new DriveTree(sdk, QUIET, new Backoff(), timers);
        let beach!: ReturnType<typeof write>;
        const first = await armedBy(timers, async () => {
            beach = write(tree, 'beach.jpg');
            await asked('beach.jpg');
        });
        let dunes!: ReturnType<typeof write>;
        const second = await armedBy(timers, async () => {
            dunes = write(tree, 'dunes.jpg');
            await asked('dunes.jpg');
        });
        timers.fireHandle(first);
        expect(timers.pending.has(second)).toBe(true);
        await expect(beach).rejects.toMatchObject({ name: 'DriveError', status: 504 });
        expect(timers.pending.has(second)).toBe(true);
        timers.fireHandle(second);
        await expect(dunes).rejects.toMatchObject({ name: 'DriveError', status: 504 });
        expect(timers.pending.size).toBe(0);
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

describe('DriveTree createFolder', () => {
    /** The SDK surface for folder creation, recording every call and its parent. */
    function fakeFolderSdk(nodes: Map<string, Node>) {
        const base = fakeSdk(nodes);
        const created: { parentUid: string; name: string }[] = [];
        const made = new Map<string, Node>();
        return {
            ...base,
            created,
            made,
            createFolder: async (parent: NodeOrUid, name: string) => {
                base.calls.set('createFolder', (base.calls.get('createFolder') ?? 0) + 1);
                const parentUid = typeof parent === 'string' ? parent : parent.uid;
                created.push({ parentUid, name });
                const uid = `new-${name}`;
                const node = folder(uid, name, parentUid);
                made.set(uid, node);
                // The made folder exists for the next listing too, as Drive would show it.
                nodes.set(uid, node);
                return structuredClone(node);
            },
            // The made folders exist for the next listing too, as Drive would show them.
            iterateFolderChildrenNodeUids: async function* (parent: NodeOrUid) {
                const uid = typeof parent === 'string' ? parent : parent.uid;
                for (const node of nodes.values()) {
                    if (node.parentUid === uid) {
                        yield node.uid;
                    }
                }
            },
        } as unknown as DriveSdk & { created: { parentUid: string; name: string }[] };
    }

    test('creating a folder calls Drive with the parent UID and shows up in the next listing', async () => {
        const nodes = new Map([[ 'root', folder('root', 'My files') ]]);
        const tree = new DriveTree(fakeFolderSdk(nodes) as never, QUIET);
        const entry = await tree.createFolder([], 'Photos');
        expect(entry).toMatchObject({ name: 'Photos', kind: 'folder', uid: 'new-Photos' });
        const names = (await tree.list(await tree.root())).map((child) => child.name);
        expect(names).toEqual(['Photos']);
    });

    test('creating a folder in a subfolder hands the subfolder UID to Drive', async () => {
        const nodes = new Map([
            [ 'root', folder('root', 'My files') ],
            [ 'photos', folder('photos', 'Photos', 'root') ],
        ]);
        const tree = new DriveTree(fakeFolderSdk(nodes) as never, QUIET);
        const entry = await tree.createFolder(['Photos'], '2025');
        expect(entry).toMatchObject({ uid: 'new-2025', parentUid: 'photos' });
    });

    test('an existing name of any kind is a 405, and Drive is never asked', async () => {
        const nodes = new Map([
            [ 'root', folder('root', 'My files') ],
            [ 'photos', folder('photos', 'Photos', 'root') ],
        ]);
        const sdk = fakeFolderSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        expect(tree.createFolder([], 'Photos')).rejects.toMatchObject({ status: 405 });
        expect(sdk.created).toEqual([]);
    });

    test('creating under a path that is not a folder is a 409', async () => {
        const nodes = new Map([
            [ 'root', folder('root', 'My files') ],
            [ 'beach', file('beach', 'beach.jpg', 'root') ],
        ]);
        const sdk = fakeFolderSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        expect(tree.createFolder(['beach.jpg'], '2025')).rejects.toMatchObject({ status: 409 });
        expect(sdk.created).toEqual([]);
    });

    test('creating under a path that does not exist is a 409', async () => {
        const nodes = new Map([[ 'root', folder('root', 'My files') ]]);
        const sdk = fakeFolderSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);
        expect(tree.createFolder(['Nope'], '2025')).rejects.toMatchObject({ status: 409 });
        expect(sdk.created).toEqual([]);
    });
});

describe('DriveTree backoff', () => {
    function rateLimitedSdk(nodes: Map<string, Node>, failingCalls: number[]) {
        const sdk = fakeSdk(nodes);
        let call = 0;
        const oldIterate = sdk.iterateFolderChildrenNodeUids.bind(sdk);
        sdk.iterateFolderChildrenNodeUids = async function* (parent: NodeOrUid) {
            if (failingCalls.includes(call++)) {
                throw new RateLimitedError('fake: Too many server requests');
            }
            yield* oldIterate(parent);
        };
        return sdk;
    }

    test('a rate-limited listing is refused as 503 with Retry-After, then resumes after the pause', async () => {
        let now = 0;
        const nodes = new Map([
            [ 'root', folder('root', 'My files') ],
            [ 'beach', file('beach', 'beach.jpg', 'root') ],
        ]);
        const tree = new DriveTree(rateLimitedSdk(nodes, [0]) as never, QUIET, new Backoff(() => now));
        // The rate limit itself comes out as the SDK's error; the handler maps it to 503.
        await expect(tree.stat(['beach.jpg'])).rejects.toBeInstanceOf(RateLimitedError);
        // Inside the pause, the ask is refused without reaching the SDK again.
        await expect(tree.stat(['beach.jpg'])).rejects.toMatchObject({ status: 503, retryAfterSeconds: 30 });
        now += 31_000;
        expect((await tree.stat(['beach.jpg']))?.name).toBe('beach.jpg');
    });

    test('a succeeded call resets the next pause to 30 seconds', async () => {
        let now = 0;
        const nodes = new Map([
            [ 'root', folder('root', 'My files') ],
            [ 'beach', file('beach', 'beach.jpg', 'root') ],
        ]);
        const backoff = new Backoff(() => now);
        const sdk = rateLimitedSdk(nodes, [0, 2]) as never;
        await expect(new DriveTree(sdk, QUIET, backoff).stat(['beach.jpg'])).rejects.toBeInstanceOf(RateLimitedError);
        now += 31_000;
        // A fresh tree stands for the next ask, since a succeeded listing stays cached.
        await new DriveTree(sdk, QUIET, backoff).stat(['beach.jpg']);
        now += 31_000;
        await expect(new DriveTree(sdk, QUIET, backoff).stat(['beach.jpg'])).rejects.toBeInstanceOf(RateLimitedError);
        await expect(new DriveTree(sdk, QUIET, backoff).stat(['beach.jpg'])).rejects.toMatchObject({
            status: 503,
            retryAfterSeconds: 30,
        });
    });
});

describe('DriveTree move', () => {
    /** The SDK surface for moves and renames, recording every call and what it could carry. */
    function fakeMoveSdk(nodes: Map<string, Node>) {
        const base = fakeSdk(nodes);
        const moves: { uid: string; toParent: string }[] = [];
        const renames: { uid: string; name: string }[] = [];
        const trashed: string[] = [];
        return {
            ...base,
            moves,
            renames,
            trashed,
            renameNode: async (uid: string, name: string) => {
                renames.push({ uid, name });
                const node = nodes.get(uid)!;
                node.name = { ok: true, value: name };
            },
            moveNodes: async function* (uids: NodeOrUid[], toParent: string) {
                base.calls.set('moveNodes', (base.calls.get('moveNodes') ?? 0) + 1);
                for (const nodeOrUid of uids) {
                    const uid = typeof nodeOrUid === 'string' ? nodeOrUid : nodeOrUid.uid;
                    moves.push({ uid, toParent });
                    const node = nodes.get(uid)!;
                    node.parentUid = toParent;
                }
            },
            trashNodes: async function* (uids: NodeOrUid[]) {
                base.calls.set('trashNodes', (base.calls.get('trashNodes') ?? 0) + 1);
                for (const nodeOrUid of uids) {
                    const uid = typeof nodeOrUid === 'string' ? nodeOrUid : nodeOrUid.uid;
                    trashed.push(uid);
                    const node = nodes.get(uid)!;
                    node.trashTime = new Date('2026-02-03T00:00:00Z');
                }
            },
            getNode: async (uid: NodeOrUid) => {
                const key = typeof uid === 'string' ? uid : uid.uid;
                return nodes.get(key)!;
            },
            iterateNodes: async function* (uids: NodeOrUid[]) {
                for (const uid of uids) {
                    const key = typeof uid === 'string' ? uid : uid.uid;
                    yield (nodes.get(key) ?? { missingUid: key }) as MaybeMissingNode;
                }
            },
            iterateFolderChildrenNodeUids: async function* (parent: NodeOrUid) {
                const uid = typeof parent === 'string' ? parent : parent.uid;
                for (const node of nodes.values()) {
                    if (node.parentUid === uid) {
                        yield node.uid;
                    }
                }
            },
        } as unknown as DriveSdk & typeof base & {
            moves: { uid: string; toParent: string }[];
            renames: { uid: string; name: string }[];
            trashed: string[];
        };
    }

    test('renaming a file keeps the same file (same UID, just name changed)', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['beach', file('beach', 'beach.jpg', 'root')],
        ]);
        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        const { entry, created } = await tree.move(['beach.jpg'], ['shore.jpg'], true);

        expect(created).toBe(true);
        expect(entry).toMatchObject({ uid: 'beach', name: 'shore.jpg', kind: 'file' });
        expect(sdk.renames).toEqual([{ uid: 'beach', name: 'shore.jpg' }]);
        expect(sdk.moves).toEqual([]);
        expect(sdk.trashed).toEqual([]);
        // After rename, the source name no longer exists
        expect((nodes.get('beach')!.name as { ok: boolean; value: string }).value).toBe('shore.jpg');
    });

    test('moving a file to another folder keeps the same file (same UID, moved)', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['beach', file('beach', 'beach.jpg', 'root')],
        ]);
        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        const { entry, created } = await tree.move(['beach.jpg'], ['Photos', 'beach.jpg'], true);

        expect(created).toBe(true);
        expect(entry).toMatchObject({ uid: 'beach', name: 'beach.jpg', kind: 'file' });
        expect(sdk.moves).toEqual([{ uid: 'beach', toParent: 'photos' }]);
        expect(sdk.renames).toEqual([]);
        expect(sdk.trashed).toEqual([]);
        // After move, the node's parentUid has changed
        expect(nodes.get('beach')!.parentUid).toBe('photos');
    });

    test('moving and renaming at once', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['img', file('img', 'IMG_0001.jpg', 'root')],
        ]);
        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        const { entry, created } = await tree.move(['IMG_0001.jpg'], ['Photos', 'beach.jpg'], true);

        expect(created).toBe(true);
        expect(entry).toMatchObject({ uid: 'img', name: 'beach.jpg', kind: 'file' });
        expect(sdk.moves).toEqual([{ uid: 'img', toParent: 'photos' }]);
        expect(sdk.renames).toEqual([{ uid: 'img', name: 'beach.jpg' }]);
        expect(sdk.trashed).toEqual([]);
    });

    test('moving onto an existing file with overwrite trashes the old one', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['beach', file('beach', 'beach.jpg', 'root')],
            ['surf', file('surf', 'new.jpg', 'root')],
        ]);
        nodes.get('beach')!.name = { ok: true, value: 'beach.jpg' };
        nodes.get('surf')!.name = { ok: true, value: 'new.jpg' };

        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        const { entry, created } = await tree.move(['new.jpg'], ['beach.jpg'], true);

        expect(created).toBe(false);
        expect(entry).toMatchObject({ uid: 'surf', name: 'beach.jpg', kind: 'file' });
        expect(sdk.moves).toEqual([]);
        expect(sdk.renames).toEqual([{ uid: 'surf', name: 'beach.jpg' }]);
        expect(sdk.trashed).toEqual(['beach']);
        expect((nodes.get('beach') as Node).trashTime).toBeDefined();
    });

    test('moving onto an existing file without overwrite is 412', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['beach', file('beach', 'beach.jpg', 'root')],
            ['surf', file('surf', 'new.jpg', 'root')],
        ]);

        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        await expect(tree.move(['new.jpg'], ['beach.jpg'], false)).rejects.toMatchObject({
            status: 412,
            message: expect.stringContaining('already exists'),
        });
        expect(sdk.moves).toEqual([]);
        expect(sdk.renames).toEqual([]);
        expect(sdk.trashed).toEqual([]);
    });

    test('renaming a folder keeps its files', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['holidays', folder('holidays', '2024', 'root')],
            ['beach', file('beach', 'beach.jpg', 'holidays')],
        ]);
        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        const { entry, created } = await tree.move(['2024'], ['Holidays 2024'], true);

        expect(created).toBe(true);
        expect(entry).toMatchObject({ uid: 'holidays', name: 'Holidays 2024', kind: 'folder' });
        expect(sdk.renames).toEqual([{ uid: 'holidays', name: 'Holidays 2024' }]);
        expect(sdk.moves).toEqual([]);
        // After rename, the folder's name has changed
        expect((nodes.get('holidays')!.name as { ok: boolean; value: string }).value).toBe('Holidays 2024');
        // And files inside the renamed folder are still accessible
        expect((await tree.stat(['Holidays 2024', 'beach.jpg']))?.uid).toBe('beach');
    });

    test('moving a folder to another folder', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['vacations', folder('vacations', 'Vacations', 'root')],
            ['beach', file('beach', 'beach.jpg', 'vacations')],
        ]);
        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        const { entry, created } = await tree.move(['Vacations'], ['Photos', 'Vacations'], true);

        expect(created).toBe(true);
        expect(entry).toMatchObject({ uid: 'vacations', name: 'Vacations', kind: 'folder' });
        expect(sdk.moves).toEqual([{ uid: 'vacations', toParent: 'photos' }]);
        expect(sdk.renames).toEqual([]);
        // Verify the folder and its contents are accessible at the new location
        expect((await tree.stat(['Photos', 'Vacations', 'beach.jpg']))?.uid).toBe('beach');
        expect((await tree.stat(['Vacations']))).toBeUndefined();
    });

    test('moving a folder to another folder with overwrite trashes old', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['vacations', folder('vacations', 'Vacations', 'root')],
            ['sunset', file('sunset', 'sunset.jpg', 'vacations')],
            ['old', folder('old', 'Vacations', 'photos')],
        ]);
        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        await tree.move(['Vacations'], ['Photos', 'Vacations'], true);

        expect(sdk.trashed).toContain('old');
        expect(sdk.moves).toEqual([{ uid: 'vacations', toParent: 'photos' }]);
        // Verify the moved folder and its contents are accessible at the new location
        expect((await tree.stat(['Photos', 'Vacations']))?.uid).toBe('vacations');
        expect((await tree.stat(['Photos', 'Vacations', 'sunset.jpg']))?.uid).toBe('sunset');
    });

    test('moving a folder into a subfolder of itself is refused', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['beach', file('beach', 'beach.jpg', 'photos')],
        ]);
        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        await expect(tree.move(['Photos'], ['Photos', 'sunset'], true)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('into itself'),
        });
        expect(sdk.moves).toEqual([]);
        expect(sdk.renames).toEqual([]);
    });

    test('moving a folder onto itself is a no-op', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['beach', file('beach', 'beach.jpg', 'photos')],
        ]);
        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        const { entry, created } = await tree.move(['Photos'], ['Photos'], true);
        expect(created).toBe(false);
        expect(entry).toMatchObject({ uid: 'photos', name: 'Photos', kind: 'folder' });
        expect(sdk.moves).toEqual([]);
        expect(sdk.renames).toEqual([]);
    });

    test('moving the root folder is refused', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
        ]);
        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        await expect(tree.move([], ['Photos'], true)).rejects.toMatchObject({
            status: 403,
            message: expect.stringContaining('root'),
        });
        expect(sdk.moves).toEqual([]);
    });

    test('moving to a non-existent parent folder is refused', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['beach', file('beach', 'beach.jpg', 'root')],
        ]);
        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        await expect(tree.move(['beach.jpg'], ['Missing', 'beach.jpg'], true)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('not a folder'),
        });
    });

    test('moving a file onto a folder that contains it is refused', async () => {
        const nodes = new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['beach', file('beach', 'beach.jpg', 'photos')],
        ]);
        const sdk = fakeMoveSdk(nodes);
        const tree = new DriveTree(sdk as never, QUIET);

        // Moving a file to its parent folder is treated as moving onto a folder that contains it
        await expect(tree.move(['Photos', 'beach.jpg'], ['Photos'], true)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('contains it'),
        });
    });
});

describe('DriveTree cache drops', () => {
    test('dropListings and clear make the next ask list the folder again', async () => {
        const nodes = new Map<string, Node>([
            ['root', folder('root', 'My files')],
            ['a', folder('a', 'a', 'root')],
        ]);
        const sdk = fakeSdk(nodes);
        const tree = new DriveTree(sdk as unknown as DriveSdk, { debug() {}, info() {}, warn() {}, error() {} } as never);
        const root = await tree.root();
        await tree.list(root);
        tree.dropListings(['root', undefined]);
        await tree.list(root);
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(2);
        tree.clear();
        await tree.list(root);
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(3);
    });
});

describe('DriveTree snapshot and restore', () => {
    function fixture(): Map<string, Node> {
        return new Map([
            ['root', folder('root', 'My files')],
            ['photos', folder('photos', 'Photos', 'root')],
            ['immich', folder('immich', 'immich', 'photos')],
            ['beach', file('beach', 'beach.jpg', 'immich')],
            ['docs', folder('docs', 'Documents', 'root')],
        ]);
    }

    /** A snapshot taken from a tree that listed My files, Photos and immich. */
    async function saved(): Promise<ListingSnapshot> {
        const tree = new DriveTree(fakeSdk(fixture()) as never, QUIET);
        await tree.stat(['Photos', 'immich', 'beach.jpg']);
        return { ...tree.snapshot()!, lastEventId: 'event-7' };
    }

    test('a tree with no root yet has nothing to snapshot', () => {
        expect(new DriveTree(fakeSdk(fixture()) as never, QUIET).snapshot()).toBeUndefined();
    });

    test('the snapshot holds each loaded listing by folder UID, keyed to My files and its event scope', async () => {
        const snapshot = await saved();
        expect(snapshot.rootUid).toBe('root');
        expect(snapshot.eventScopeId).toBe('volume-1');
        expect([...snapshot.listings.keys()].sort()).toEqual(['immich', 'photos', 'root']);
        expect(snapshot.listings.get('immich')!.map((entry) => entry.uid)).toEqual(['beach']);
    });

    test('a dropped listing, and one that is still loading, are not in the snapshot', async () => {
        const tree = new DriveTree(fakeSdk(fixture()) as never, QUIET);
        const docs = (await tree.stat(['Documents']))!;
        await tree.stat(['Photos', 'immich']);
        tree.dropListings(['photos']);
        const loading = tree.list(docs);
        expect([...tree.snapshot()!.listings.keys()].sort()).toEqual(['root']);
        await loading;
        expect([...tree.snapshot()!.listings.keys()].sort()).toEqual(['docs', 'root']);
    });

    test('counts the listings it loaded from Drive, so a periodic save can tell nothing new loaded', async () => {
        const tree = new DriveTree(fakeSdk(fixture()) as never, QUIET);
        expect(tree.listingsLoaded).toBe(0);
        await tree.stat(['Photos', 'immich']);
        expect(tree.listingsLoaded).toBe(2);
        await tree.stat(['Photos', 'immich']);
        expect(tree.listingsLoaded).toBe(2);
        tree.dropListings(['photos']);
        await tree.stat(['Photos', 'immich']);
        expect(tree.listingsLoaded).toBe(3);
    });

    test('a restored tree answers from the snapshot without listing Drive, and keeps its event id', async () => {
        const sdk = fakeSdk(fixture());
        const tree = new DriveTree(sdk as never, QUIET, undefined, { restore: await saved() });
        expect(tree.restoredEventId).toBeUndefined();
        expect((await tree.stat(['Photos', 'immich', 'beach.jpg']))?.uid).toBe('beach');
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBeUndefined();
        expect(sdk.calls.get('iterateNodes')).toBeUndefined();
        expect(tree.restoredEventId).toBe('event-7');
    });

    test('a restored tree with a root path walks to it through Drive, and answers below it from the snapshot', async () => {
        const sdk = fakeSdk(fixture());
        const tree = new DriveTree(sdk as never, QUIET, undefined, { rootPath: ['Photos', 'immich'], restore: await saved() });
        expect((await tree.root()).uid).toBe('immich');
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(2);
        expect((await tree.stat(['beach.jpg']))?.uid).toBe('beach');
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(2);
    });

    test('a root folder renamed while the serve was down is missing, though the snapshot still lists it', async () => {
        const nodes = fixture();
        nodes.set('photos', folder('photos', 'Pics', 'root'));
        const tree = new DriveTree(fakeSdk(nodes) as never, QUIET, undefined, { rootPath: ['Photos'], restore: await saved() });
        await expect(tree.root()).rejects.toThrow('Root folder /Photos does not exist in My files');
    });

    test('a root folder trashed while the serve was down is missing, though the snapshot still lists it', async () => {
        const nodes = fixture();
        nodes.set('photos', { ...folder('photos', 'Photos', 'root'), trashTime: new Date() } as Node);
        const tree = new DriveTree(fakeSdk(nodes) as never, QUIET, undefined, { rootPath: ['Photos'], restore: await saved() });
        await expect(tree.root()).rejects.toThrow('Root folder /Photos does not exist in My files');
    });

    test('restored listings no one asked for again are still in the next snapshot', async () => {
        const restore = await saved();
        const tree = new DriveTree(fakeSdk(fixture()) as never, QUIET, undefined, { restore });
        await tree.root();
        expect(tree.snapshot()!.listings).toEqual(restore.listings);
    });

    test('a snapshot of another My files is ignored, and the tree lists Drive', async () => {
        const sdk = fakeSdk(fixture());
        const tree = new DriveTree(sdk as never, QUIET, undefined, { restore: { ...(await saved()), rootUid: 'other-root' } });
        expect((await tree.stat(['Photos', 'immich', 'beach.jpg']))?.uid).toBe('beach');
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(3);
        expect(tree.restoredEventId).toBeUndefined();
    });

    test('a snapshot of another event scope is ignored, and the tree lists Drive', async () => {
        const sdk = fakeSdk(fixture());
        const tree = new DriveTree(sdk as never, QUIET, undefined, { restore: { ...(await saved()), eventScopeId: 'volume-2' } });
        await tree.stat(['Photos']);
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(1);
        expect(tree.restoredEventId).toBeUndefined();
    });

    test('a restored listing an event drops loads from Drive again', async () => {
        const sdk = fakeSdk(fixture());
        const tree = new DriveTree(sdk as never, QUIET, undefined, { restore: await saved() });
        await tree.root();
        tree.dropListings(['immich']);
        expect((await tree.stat(['Photos', 'immich', 'beach.jpg']))?.uid).toBe('beach');
        expect(sdk.calls.get('iterateFolderChildrenNodeUids')).toBe(1);
    });
});
