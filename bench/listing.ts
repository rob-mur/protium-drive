import { NodeType, type MaybeMissingNode, type NodeEntity, type NodeOrUid } from '@protontech/drive-sdk';

import { Backoff } from '../src/drive/backoff';
import { isSkipped, toEntry } from '../src/drive/entry';
import type { DriveSdk } from '../src/drive/sdk';
import { DriveTree } from '../src/drive/tree';
import { initCryptoWorker } from '../src/proton/crypto-pool';
import { multistatusStream } from '../src/webdav/xml';

import { importNodeKey } from './crypto';
import { makeNodeKeys, type NodeKey } from './keys';
import { timed } from './stats';

/** The SDK loads nodes in batches of this many (`BATCH_LOADING_SIZE` in drive-sdk's `nodesAccess.ts`). */
export const NODE_BATCH = 30;

export type ListingOptions = {
    /** Simulated round trip, in ms, for each UID page and each node batch. */
    roundTripMs: number;
    /** UIDs the folder-children call returns per page. The server picks the real size; this is an assumption. */
    uidPage: number;
    /** Distinct real keys per kind that file nodes draw from. */
    distinctKeys: number;
};

export type ListingRow = {
    files: number;
    argon2Fraction: number;
    uidDrainMs: number;
    nodeRoundTripMs: number;
    nodeCryptoMs: number;
    /** Everything the shim spent inside `iterateNodes`: round trips plus crypto. */
    nodeIterationMs: number;
    /** `toEntry` over the same nodes, timed alone. */
    toEntryMs: number;
    /** `listMs` minus UID drain minus node iteration: the tree's own work, `toEntry` included. */
    treeOtherMs: number;
    /** `tree.list` on a cold folder (runs `loadListing`). */
    listMs: number;
    /** `tree.list` on the same folder again. */
    cachedListMs: number;
    xmlMs: number;
    xmlBytes: number;
    totalMs: number;
};

const FOLDER = 'photos';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

const fileNode = (index: number, key: NodeKey) =>
    ({
        uid: `file-${index}`,
        parentUid: FOLDER,
        type: NodeType.File,
        name: { ok: true, value: `IMG_${String(index + 1).padStart(5, '0')}.jpg` },
        mediaType: 'image/jpeg',
        creationTime: new Date('2026-01-01T00:00:00Z'),
        modificationTime: new Date('2026-01-02T00:00:00Z'),
        treeEventScopeId: 'volume-1',
        encryptedCrypto: { armoredKey: key.armoredKey },
        activeRevision: { uid: `file-${index}-rev`, claimedSize: 2_000_000, claimedModificationTime: undefined, claimedDigests: {} },
    }) as unknown as NodeEntity;

/** A Drive whose `Photos` folder holds `files` photos; the first `argon2` of them carry v6 Argon2 node keys. */
export function buildDrive(files: number, argon2: number, v4Keys: NodeKey[], v6Keys: NodeKey[]) {
    const nodes = new Map<string, NodeEntity>([
        ['root', folderNode('root', 'My files')],
        [FOLDER, folderNode(FOLDER, 'Photos', 'root')],
    ]);
    const keys = new Map<string, NodeKey>();
    for (let i = 0; i < files; i++) {
        const key = i < argon2 ? v6Keys[i % v6Keys.length] : v4Keys[i % v4Keys.length];
        nodes.set(`file-${i}`, fileNode(i, key));
        keys.set(`file-${i}`, key);
    }
    return { nodes, keys };
}

type Clock = { uidDrainMs: number; nodeRoundTripMs: number; nodeCryptoMs: number; nodeIterationMs: number };

/**
 * The SDK's listing surface over an in-memory Drive. Each UID page and each 30-node batch waits one
 * round trip; then every file node in the batch imports its node key through the real crypto
 * worker, all 30 at once as the SDK's decryption does. The clock gets the time spent in each.
 */
export function shimmedSdk(drive: ReturnType<typeof buildDrive>, options: ListingOptions, clock: Clock): DriveSdk {
    const { nodes, keys } = drive;
    const uidOf = (u: NodeOrUid) => (typeof u === 'string' ? u : u.uid);
    return {
        getMyFilesRootFolder: async () => nodes.get('root')!,
        iterateFolderChildrenNodeUids: async function* (parent: NodeOrUid) {
            const children = [...nodes.values()].filter((node) => node.parentUid === uidOf(parent)).map((node) => node.uid);
            for (let at = 0; ; at += options.uidPage) {
                const start = performance.now();
                await sleep(options.roundTripMs);
                clock.uidDrainMs += performance.now() - start;
                yield* children.slice(at, at + options.uidPage);
                if (at + options.uidPage >= children.length) {
                    return;
                }
            }
        },
        iterateNodes: async function* (wanted: NodeOrUid[]) {
            for (let at = 0; at < wanted.length; at += NODE_BATCH) {
                const start = performance.now();
                const batch = wanted.slice(at, at + NODE_BATCH).map(uidOf);
                const trip = await timed(() => sleep(options.roundTripMs));
                const crypto = await timed(() => Promise.all(batch.map((uid) => (keys.has(uid) ? importNodeKey(keys.get(uid)!) : undefined))));
                clock.nodeRoundTripMs += trip.ms;
                clock.nodeCryptoMs += crypto.ms;
                clock.nodeIterationMs += performance.now() - start;
                yield* batch.map((uid) => nodes.get(uid) ?? ({ missingUid: uid } as MaybeMissingNode));
            }
        },
    } as unknown as DriveSdk;
}

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

/** One listing of a cold folder, split into phases. */
export async function listOnce(drive: ReturnType<typeof buildDrive>, options: ListingOptions) {
    const clock: Clock = { uidDrainMs: 0, nodeRoundTripMs: 0, nodeCryptoMs: 0, nodeIterationMs: 0 };
    const tree = new DriveTree(shimmedSdk(drive, options, clock), QUIET, new Backoff());
    const root = await tree.root();
    const folder = (await tree.list(root)).find((entry) => entry.uid === FOLDER)!;
    // Every later wait on the clock is the folder's own, not the root's.
    Object.assign(clock, { uidDrainMs: 0, nodeRoundTripMs: 0, nodeCryptoMs: 0, nodeIterationMs: 0 });

    const cold = await timed(() => tree.list(folder));
    const cached = await timed(() => tree.list(folder));
    const xml = await timed(() => new Response(multistatusStream(['Photos'], folder, cold.value)).text());
    const toEntryTime = await timed(async () => [...drive.nodes.values()].map((node) => isSkipped(toEntry(node))));
    return { clock, cold, cached, xml, toEntryMs: toEntryTime.ms, totalMs: cold.ms + xml.ms };
}

/** Times a listing for each count of files and each share of Argon2 keys. */
export async function benchListing(sizes: number[], argon2Fractions: number[], options: ListingOptions): Promise<ListingRow[]> {
    initCryptoWorker();
    const v4Keys = await makeNodeKeys('v4', options.distinctKeys, options.distinctKeys);
    const v6Keys = await makeNodeKeys('v6-argon2', options.distinctKeys, options.distinctKeys);
    const rows: ListingRow[] = [];
    for (const files of sizes) {
        for (const argon2Fraction of argon2Fractions) {
            const drive = buildDrive(files, Math.round(files * argon2Fraction), v4Keys, v6Keys);
            const run = await listOnce(drive, options);
            rows.push({
                files,
                argon2Fraction,
                uidDrainMs: run.clock.uidDrainMs,
                nodeRoundTripMs: run.clock.nodeRoundTripMs,
                nodeCryptoMs: run.clock.nodeCryptoMs,
                nodeIterationMs: run.clock.nodeIterationMs,
                toEntryMs: run.toEntryMs,
                treeOtherMs: run.cold.ms - run.clock.uidDrainMs - run.clock.nodeIterationMs,
                listMs: run.cold.ms,
                cachedListMs: run.cached.ms,
                xmlMs: run.xml.ms,
                xmlBytes: run.xml.value.length,
                totalMs: run.totalMs,
            });
        }
    }
    return rows;
}
