import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeType, type NodeEntity, type NodeOrUid } from '@protontech/drive-sdk';

import { Backoff } from '../src/drive/backoff';
import type { Entry } from '../src/drive/entry';
import { ListingCacheFile } from '../src/drive/listing-cache';
import type { DriveSdk } from '../src/drive/sdk';
import { DriveTree } from '../src/drive/tree';
import { initCryptoWorker } from '../src/proton/crypto-pool';

import { shimmedSdk, type ListingOptions } from './listing';
import { makeNodeKeys, type NodeKey } from './keys';
import { timed } from './stats';

export type TreeOptions = ListingOptions & {
    /** Photos in the library, spread evenly over the month folders. */
    files: number;
    /** Year folders, of 12 month folders each. */
    years: number;
    /** Folders listed at once, as rclone's checkers walk a tree. */
    concurrency: number;
};

export type TreeRow = {
    run: 'cold' | 'warm';
    files: number;
    folders: number;
    walkMs: number;
    /** Folder listings and node loads the walk asked the Drive for. */
    driveListings: number;
    driveNodeLoads: number;
    /** Cold: the snapshot and write of listing-cache.json. Warm: its read and parse. */
    cacheMs: number;
    cacheBytes: number;
};

const folderNode = (uid: string, name: string, parentUid?: string) =>
    ({
        uid,
        parentUid,
        type: NodeType.Folder,
        name: { ok: true, value: name },
        creationTime: new Date('2026-01-01T00:00:00Z'),
        modificationTime: new Date('2026-01-02T00:00:00Z'),
        treeEventScopeId: 'volume-1',
    }) as unknown as NodeEntity;

const photoNode = (index: number, parentUid: string, key: NodeKey) =>
    ({
        uid: `file-${index}`,
        parentUid,
        type: NodeType.File,
        name: { ok: true, value: `IMG_${String(index + 1).padStart(6, '0')}.jpg` },
        mediaType: 'image/jpeg',
        creationTime: new Date('2026-01-01T00:00:00Z'),
        modificationTime: new Date('2026-01-02T00:00:00Z'),
        treeEventScopeId: 'volume-1',
        encryptedCrypto: { armoredKey: key.armoredKey },
        activeRevision: { uid: `file-${index}-rev`, claimedSize: 2_000_000, claimedModificationTime: undefined, claimedDigests: {} },
    }) as unknown as NodeEntity;

/**
 * A Drive shaped like an immich library: My files / Photos / immich / <year> / <month>, with
 * `files` photos spread evenly over the month folders. Every photo carries a v4 node key.
 */
export function buildLibrary(files: number, years: number, keys: NodeKey[]) {
    const nodes = new Map<string, NodeEntity>([
        ['root', folderNode('root', 'My files')],
        ['photos', folderNode('photos', 'Photos', 'root')],
        ['immich', folderNode('immich', 'immich', 'photos')],
    ]);
    const months: string[] = [];
    for (let y = 0; y < years; y++) {
        const year = `year-${y}`;
        nodes.set(year, folderNode(year, String(2026 - years + 1 + y), 'immich'));
        for (let m = 1; m <= 12; m++) {
            const month = `${year}-${m}`;
            nodes.set(month, folderNode(month, String(m).padStart(2, '0'), year));
            months.push(month);
        }
    }
    const nodeKeys = new Map<string, NodeKey>();
    for (let i = 0; i < files; i++) {
        const key = keys[i % keys.length]!;
        nodes.set(`file-${i}`, photoNode(i, months[i % months.length]!, key));
        nodeKeys.set(`file-${i}`, key);
    }
    return { nodes, keys: nodeKeys, folders: nodes.size - files };
}

/** The shim, counting the folder listings and node loads asked of it. */
function countingSdk(sdk: DriveSdk) {
    const counts = { listings: 0, nodeLoads: 0 };
    const counted = {
        ...sdk,
        iterateFolderChildrenNodeUids(parent: NodeOrUid) {
            counts.listings++;
            return sdk.iterateFolderChildrenNodeUids(parent);
        },
        iterateNodes(uids: NodeOrUid[]) {
            counts.nodeLoads += uids.length;
            return sdk.iterateNodes(uids);
        },
    } as DriveSdk;
    return { sdk: counted, counts };
}

/** Lists every folder under the root, `concurrency` at a time, as a client walking the tree. */
async function walk(tree: DriveTree, concurrency: number): Promise<number> {
    const queue: Entry[] = [await tree.root()];
    let listed = 0;
    let active = 0;
    await new Promise<void>((resolve, reject) => {
        const next = () => {
            if (queue.length === 0 && active === 0) {
                resolve();
                return;
            }
            while (active < concurrency && queue.length > 0) {
                const folder = queue.shift()!;
                active++;
                tree.list(folder).then((children) => {
                    listed++;
                    queue.push(...children.filter((child) => child.kind === 'folder'));
                    active--;
                    next();
                }, reject);
            }
        };
        next();
    });
    return listed;
}

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Walks an immich-sized tree twice: cold, as a first start (or a start after a kill with no saved
 * listings) lists it, then warm, as a restart that read listing-cache.json lists it.
 */
export async function benchTree(options: TreeOptions): Promise<TreeRow[]> {
    initCryptoWorker();
    const keys = await makeNodeKeys('v4', options.distinctKeys, options.distinctKeys);
    const drive = buildLibrary(options.files, options.years, keys);
    const clock = { uidDrainMs: 0, nodeRoundTripMs: 0, nodeCryptoMs: 0, nodeIterationMs: 0 };
    const stateDir = await mkdtemp(path.join(tmpdir(), 'pdm-bench-tree-'));
    try {
        const cacheFile = new ListingCacheFile(stateDir);

        const cold = countingSdk(shimmedSdk(drive, options, clock));
        const coldTree = new DriveTree(cold.sdk, QUIET, new Backoff());
        const coldWalk = await timed(() => walk(coldTree, options.concurrency));
        const save = await timed(() => cacheFile.write({ ...coldTree.snapshot()!, lastEventId: 'event-1' }));
        const bytes = (await stat(cacheFile.filePath)).size;

        const warm = countingSdk(shimmedSdk(drive, options, clock));
        const read = await timed(() => cacheFile.read());
        const warmTree = new DriveTree(warm.sdk, QUIET, new Backoff(), { restore: read.value });
        const warmWalk = await timed(() => walk(warmTree, options.concurrency));

        const row = (run: TreeRow['run'], walked: typeof coldWalk, counts: typeof cold.counts, cacheMs: number): TreeRow => ({
            run,
            files: options.files,
            folders: walked.value,
            walkMs: walked.ms,
            driveListings: counts.listings,
            driveNodeLoads: counts.nodeLoads,
            cacheMs,
            cacheBytes: bytes,
        });
        return [row('cold', coldWalk, cold.counts, save.ms), row('warm', warmWalk, warm.counts, read.ms)];
    } finally {
        await rm(stateDir, { recursive: true, force: true });
    }
}
