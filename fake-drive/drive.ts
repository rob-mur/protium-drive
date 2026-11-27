/**
 * The Receive arm's Drive: an in-memory "My files" behind the part of `ProtonDriveClient` the
 * product uses, for tests only. Nothing here reaches Proton. It imitates the SDK from its types
 * and from the prototype's fake (`prototype/webdav-mount` at 7bff71f, `tests/support/fakeSdk.ts`).
 *
 * Two objects share one Drive:
 * - `FakeDriveClient` is the SDK surface the product gets in place of `ProtonDriveClient`.
 * - `FakeDrive` holds the state. Its `add`, `rename` and `trash` act as another client, and its
 *   reads (`nodeAt`, `content`, `revisions`, `trashed`) are what the control channel answers.
 *
 * State lives in a directory, `DIR`, so the Drive survives a restart and two processes on one
 * `DIR` see one Drive:
 * - `DIR/drive.json`: the nodes, their revisions and the Drive events (format below, `DriveState`).
 *   Every change rewrites it atomically, and every call reloads it when another process changed it.
 * - `DIR/blobs/<sha256>`: the content of each revision, by its SHA-256.
 *
 * The state format is the seed format. To seed a Drive before the binary starts, open it with
 * `FakeDrive.open(DIR)` and call `add`.
 */
import type { PrivateKeyReference } from '@protontech/crypto';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    AbortError,
    DecryptionError,
    type DownloadController,
    type DriveEvent,
    DriveEventType,
    type EventScheduler,
    type FileDownloader,
    type FileUploader,
    IntegrityError,
    type MaybeMissingNode,
    MemberRole,
    type NodeEntity,
    type NodeOrUid,
    type NodeResult,
    NodeType,
    NodeWithSameNameExistsValidationError,
    type ProtonDriveClient,
    RevisionState,
    type SeekableReadableStream,
    type UploadController,
    type UploadMetadata,
    ValidationError,
} from '@protontech/drive-sdk';

import { type Clock, FakeClock, type TimerHandle } from './clock.ts';
import { type Fault, faultError, type FaultKind, type Faults, type Operation } from './faults.ts';
import { armoredNodeKey, type NodeKeyKind, nodeKeyVersion } from './node-keys.ts';
import { DECRYPTION_CONCURRENCY, mapConcurrently, RealCrypto } from './real-crypto.ts';
import type { Requirements, ResponseHook } from './requirements.ts';
import { StateFile } from './state-file.ts';

/** The part of `ProtonDriveClient` the product uses: the prototype's `DriveSdk` pick. */
export type SdkSurface = Pick<
    ProtonDriveClient,
    | 'getMyFilesRootFolder'
    | 'iterateFolderChildrenNodeUids'
    | 'iterateNodes'
    | 'getNode'
    | 'createFolder'
    | 'getFileUploader'
    | 'getFileRevisionUploader'
    | 'getFileDownloader'
    | 'trashNodes'
    | 'renameNode'
    | 'moveNodes'
    | 'getEventScheduler'
    | 'iterateEvents'
>;

/** The one volume, and so the one Drive event scope, of the Receive arm's Drive. */
export const SCOPE_ID = 'volume-1';
const OWNER = 'receive-arm@fake-drive.invalid';
const DOWNLOAD_CHUNK = 64 * 1024;
/** Proton's block size: the unit a seekable stream fetches (`DriveState.blockFetchMs`). */
const BLOCK_SIZE = 4 * 1024 * 1024;
/** The NAME_TAKEN code the SDK gives with a name clash. */
export const NAME_TAKEN = 2500;
const MAX_NAME_LENGTH = 255;
/** The SDK polls the events of the user's own volume every 30 s (plus up to 1 s of jitter, left out here). */
export const EVENT_POLL_MS = 30_000;

/** `DIR/drive.json`. Dates are ISO 8601 strings. */
export type DriveState = {
    format: 1;
    rootUid: string;
    nextId: number;
    nextEventId: number;
    nodes: Record<string, NodeRecord>;
    events: DriveEvent[];
    /**
     * True: the SDK surface does the SDK's crypto for real (real-crypto.ts). Loading a file's node
     * unlocks its node key, and a download decrypts the file's content, through the product's
     * crypto pool. Absent: it does no crypto.
     */
    realCrypto?: boolean;
    /**
     * Wall-clock milliseconds a seekable stream waits for each 4 MiB block that a read of it
     * fetches, as the SDK waits for a block's token and its download. Absent: no wait.
     */
    blockFetchMs?: number;
};

export type NodeRecord = {
    uid: string;
    parentUid?: string;
    name: string;
    type: 'file' | 'folder';
    created: string;
    modified: string;
    trashed?: string;
    /** A folder's `modificationTime` from `createFolder`: the caller's claimed time, not the server time `modified`. */
    claimedModificationTime?: string;
    /** A file's revisions, oldest first; the last one is the active revision. A folder has none. */
    revisions: RevisionRecord[];
    /** The SDK gives this node's name as `{ ok: false }`, as for a name it cannot decrypt. */
    nameUndecryptable?: boolean;
    /** False: the SDK gives no clear-text size (`claimedSize`) for this file. */
    clearTextSize?: boolean;
    /** The node key this file holds (node-keys.ts). A file with none given, and any file the SDK uploads, holds a `v4` key. */
    nodeKey?: NodeKeyKind;
};

export type RevisionRecord = {
    uid: string;
    created: string;
    /** SHA-256 of the content, the name of its file in `DIR/blobs/`. */
    blob: string;
    size: number;
    /** The upload's `expectedSize`. */
    declaredSize: number | null;
    mediaType: string;
    claimedModificationTime?: string;
};

export type NodeInfo = Omit<NodeRecord, 'revisions'> & {
    path: string;
    mediaType?: string;
    revisionCount: number;
    /** The OpenPGP version (4 or 6) of a file's node key, read from the key itself. A folder has none. */
    nodeKeyVersion?: number;
};
export type RevisionInfo = Omit<RevisionRecord, 'blob'> & { state: 'active' | 'superseded' };

/** What another client adds at a path. */
export type AddSpec =
    | { type: 'folder' }
    | {
          type: 'file';
          content: Uint8Array;
          mediaType?: string;
          nameUndecryptable?: boolean;
          clearTextSize?: boolean;
          nodeKey?: NodeKeyKind;
          /** The modification time the other client's upload claims, as a device that edits a file does. */
          modificationTime?: Date;
      };

/**
 * The calls the product made through one `FakeDriveClient`, kept in memory, not in `DIR`. A
 * generator method counts when the product starts to iterate it, as the SDK sends its request then.
 */
export type CallCounts = {
    /** Per SDK method, and `uploadFromStream` per upload started. */
    methods: Record<string, number>;
    /** `iterateFolderChildrenNodeUids`, per folder UID. */
    listings: Record<string, number>;
    /** `getNode` and `iterateNodes`, per node UID loaded. */
    nodeLoads: Record<string, number>;
    /** `getFileDownloader`, per node UID. */
    downloads: Record<string, number>;
};

/** No node has the UID or the path asked for. */
export class NoSuchNodeError extends ValidationError {
    override name = 'NoSuchNodeError';
}

type Content = { content: Uint8Array; mediaType: string; declaredSize: number | null; modificationTime?: Date };

export class FakeDrive {
    private state!: DriveState;

    private constructor(
        private readonly dir: string,
        private readonly file: StateFile<DriveState>,
    ) {
        this.sync();
    }

    /** Opens the Drive kept in `dir`, and creates an empty one there if it holds none. */
    static open(dir: string): FakeDrive {
        mkdirSync(join(dir, 'blobs'), { recursive: true });
        const file = new StateFile<DriveState>(join(dir, 'drive.json'), () => {
            const now = new Date().toISOString();
            const rootUid = `${SCOPE_ID}~link-1`;
            return {
                format: 1,
                rootUid,
                nextId: 2,
                nextEventId: 1,
                nodes: { [rootUid]: { uid: rootUid, name: 'root', type: 'folder', created: now, modified: now, revisions: [] } },
                events: [],
            };
        });
        return new FakeDrive(dir, file);
    }

    get rootUid(): string {
        this.sync();
        return this.state.rootUid;
    }

    /** Whether the SDK surface does the SDK's crypto for real (`DriveState.realCrypto`). */
    get realCrypto(): boolean {
        this.sync();
        return this.state.realCrypto === true;
    }

    /** What a seekable stream waits per block it fetches (`DriveState.blockFetchMs`), in ms. */
    get blockFetchMs(): number {
        this.sync();
        return this.state.blockFetchMs ?? 0;
    }

    // --- reads, for the control channel ------------------------------------

    /** The node at `path` (`/`-separated names from My files; trashed nodes take no path). */
    nodeAt(path: string): NodeInfo {
        this.sync();
        return this.info(this.resolve(path));
    }

    /** The content of the active revision at `path`, or of the revision `revisionUid`. */
    content(path: string, revisionUid?: string): Uint8Array<ArrayBuffer> {
        this.sync();
        const node = this.resolve(path);
        const revision = revisionUid ? node.revisions.find((r) => r.uid === revisionUid) : node.revisions.at(-1);
        if (!revision) throw new NoSuchNodeError(`fake-drive: ${path} has no revision ${revisionUid ?? ''}`.trim());
        return this.readBlob(revision.blob);
    }

    revisions(path: string): RevisionInfo[] {
        this.sync();
        const node = this.resolve(path);
        return node.revisions.map(({ blob: _, ...revision }, index) => ({
            ...revision,
            state: index === node.revisions.length - 1 ? 'active' : 'superseded',
        }));
    }

    /**
     * The path of the node `uid` (as `nodeAt` takes it), or undefined when there is no such node or
     * when it takes no path: it or a folder above it is trashed.
     */
    pathOfUid(uid: string): string | undefined {
        this.sync();
        for (let at: NodeRecord | undefined = this.state.nodes[uid]; at; at = at.parentUid ? this.state.nodes[at.parentUid] : undefined) {
            if (at.trashed) return undefined;
        }
        const node = this.state.nodes[uid];
        return node && this.pathOf(node);
    }

    trashed(): NodeInfo[] {
        this.sync();
        return Object.values(this.state.nodes)
            .filter((node) => node.trashed)
            .map((node) => this.info(node));
    }

    // --- another client ----------------------------------------------------

    /**
     * Adds a folder or a file at `path` and the folders above it. A file that exists gets a new
     * revision. Each name must pass the SDK's name check, as a node added through the SDK must.
     */
    add(path: string, spec: AddSpec): string {
        return this.change(() => {
            const segments = splitPath(path);
            segments.forEach(validateName);
            const name = segments.pop();
            if (!name) throw new ValidationError('fake-drive: cannot add My files itself');
            let parent = this.state.nodes[this.state.rootUid]!;
            for (const segment of segments) {
                parent = this.childByName(parent.uid, segment) ?? this.insert(parent.uid, segment, 'folder');
                if (parent.type !== 'folder') throw new ValidationError(`fake-drive: ${segment} is not a folder`);
            }
            const existing = this.childByName(parent.uid, name);
            if (spec.type === 'folder') {
                if (existing && existing.type !== 'folder') throw new ValidationError(`fake-drive: ${path} is a file`);
                return (existing ?? this.insert(parent.uid, name, 'folder')).uid;
            }
            const content = {
                content: spec.content,
                mediaType: spec.mediaType ?? 'application/octet-stream',
                declaredSize: spec.content.length,
                modificationTime: spec.modificationTime,
            };
            const node = existing ?? this.insert(parent.uid, name, 'file', content, true);
            if (existing) {
                if (existing.type !== 'file') throw new ValidationError(`fake-drive: ${path} is a folder`);
                this.appendRevision(existing, content);
            }
            if (spec.nameUndecryptable !== undefined) node.nameUndecryptable = spec.nameUndecryptable;
            if (spec.clearTextSize !== undefined) node.clearTextSize = spec.clearTextSize;
            if (spec.nodeKey !== undefined) node.nodeKey = spec.nodeKey;
            this.emit(existing ? DriveEventType.NodeUpdated : DriveEventType.NodeCreated, node);
            return node.uid;
        });
    }

    rename(path: string, newName: string): string {
        this.sync();
        return this.renameNode(this.resolve(path).uid, newName);
    }

    trash(path: string): string {
        this.sync();
        const uid = this.resolve(path).uid;
        this.trashNode(uid);
        return uid;
    }

    // --- operations behind the SDK surface ---------------------------------

    record(uid: string): Readonly<NodeRecord> | undefined {
        this.sync();
        return this.state.nodes[uid];
    }

    childUids(parentUid: string): string[] {
        this.sync();
        return Object.values(this.state.nodes)
            .filter((node) => node.parentUid === parentUid)
            .map((node) => node.uid);
    }

    revisionContent(revision: RevisionRecord): Uint8Array<ArrayBuffer> {
        return this.readBlob(revision.blob);
    }

    /** Throws as the SDK does when `name` is taken in the folder `parentUid`. */
    checkFreeName(parentUid: string, name: string): void {
        this.sync();
        const parent = this.require(parentUid);
        if (parent.type !== 'folder') throw new ValidationError(`fake-drive: ${parent.name} is not a folder`);
        const existing = this.childByName(parentUid, name);
        if (existing) {
            throw new NodeWithSameNameExistsValidationError('fake-drive: a node with this name already exists', NAME_TAKEN, existing.uid, false);
        }
    }

    createFolder(parentUid: string, name: string, modificationTime?: Date): string {
        return this.change(() => {
            validateName(name);
            this.checkFreeName(parentUid, name);
            const node = this.insert(parentUid, name, 'folder');
            if (modificationTime) node.claimedModificationTime = modificationTime.toISOString();
            return node.uid;
        });
    }

    createFile(parentUid: string, name: string, content: Content): { nodeUid: string; nodeRevisionUid: string } {
        return this.change(() => {
            validateName(name);
            this.checkFreeName(parentUid, name);
            const node = this.insert(parentUid, name, 'file', content);
            return { nodeUid: node.uid, nodeRevisionUid: node.revisions.at(-1)!.uid };
        });
    }

    createRevision(uid: string, content: Content): { nodeUid: string; nodeRevisionUid: string } {
        return this.change(() => {
            const node = this.require(uid);
            if (node.type !== 'file') throw new ValidationError(`fake-drive: ${node.name} is not a file`);
            this.appendRevision(node, content);
            this.emit(DriveEventType.NodeUpdated, node);
            return { nodeUid: uid, nodeRevisionUid: node.revisions.at(-1)!.uid };
        });
    }

    renameNode(uid: string, newName: string): string {
        return this.change(() => {
            validateName(newName);
            const node = this.require(uid);
            if (uid === this.state.rootUid) throw new ValidationError('fake-drive: Renaming root item is not allowed');
            if (node.parentUid) {
                const existing = this.childByName(node.parentUid, newName);
                if (existing && existing.uid !== uid) {
                    throw new NodeWithSameNameExistsValidationError('fake-drive: a node with this name already exists', NAME_TAKEN, existing.uid, false);
                }
            }
            node.name = newName;
            node.modified = new Date().toISOString();
            this.emit(DriveEventType.NodeUpdated, node);
            return uid;
        });
    }

    moveNode(uid: string, newParentUid: string): void {
        this.change(() => {
            const node = this.require(uid);
            if (uid === this.state.rootUid) throw new ValidationError('fake-drive: My files cannot be moved');
            for (let at: NodeRecord | undefined = this.require(newParentUid); at; at = at.parentUid ? this.state.nodes[at.parentUid] : undefined) {
                if (at.uid === uid) throw new ValidationError(`fake-drive: ${node.name} cannot move into itself or below itself`);
            }
            this.checkFreeName(newParentUid, node.name);
            node.parentUid = newParentUid;
            node.modified = new Date().toISOString();
            this.emit(DriveEventType.NodeUpdated, node);
        });
    }

    trashNode(uid: string): void {
        this.change(() => {
            const node = this.require(uid);
            if (uid === this.state.rootUid) throw new ValidationError('fake-drive: My files cannot be trashed');
            node.trashed = new Date().toISOString();
            this.emit(DriveEventType.NodeUpdated, node);
        });
    }

    latestEventId(): string {
        this.sync();
        return String(this.state.nextEventId - 1);
    }

    eventsAfter(lastEventId: string): DriveEvent[] {
        this.sync();
        return this.state.events.filter((event) => Number(event.eventId) > Number(lastEventId));
    }

    // --- internals ----------------------------------------------------------

    /** Runs `fn` on the latest state and saves what it changed. When `fn` or the save throws, nothing changes. */
    private change<T>(fn: () => T): T {
        return this.file.change((state) => {
            this.state = state;
            return fn();
        });
    }

    /** Takes the latest state, which another process may have saved since this one last read it. */
    private sync(): void {
        this.state = this.file.read() as DriveState;
    }

    private writeBlob(content: Uint8Array): string {
        const id = createHash('sha256').update(content).digest('hex');
        const path = join(this.dir, 'blobs', id);
        if (!existsSync(path)) {
            writeFileSync(`${path}.${process.pid}.tmp`, content);
            renameSync(`${path}.${process.pid}.tmp`, path);
        }
        return id;
    }

    private readBlob(id: string): Uint8Array<ArrayBuffer> {
        return new Uint8Array(readFileSync(join(this.dir, 'blobs', id)));
    }

    private resolve(path: string): NodeRecord {
        let node = this.state.nodes[this.state.rootUid]!;
        for (const name of splitPath(path)) {
            const child = this.childByName(node.uid, name);
            if (!child) throw new NoSuchNodeError(`fake-drive: no node at ${path}`);
            node = child;
        }
        return node;
    }

    private pathOf(node: NodeRecord): string {
        const names: string[] = [];
        for (let at: NodeRecord | undefined = node; at?.parentUid; at = this.state.nodes[at.parentUid]) names.unshift(at.name);
        return names.join('/');
    }

    private info(node: NodeRecord): NodeInfo {
        const { revisions, ...rest } = node;
        return {
            ...rest,
            path: this.pathOf(node),
            mediaType: revisions.at(-1)?.mediaType,
            revisionCount: revisions.length,
            nodeKeyVersion: node.type === 'file' ? nodeKeyVersion(armoredNodeKey(node.nodeKey)) : undefined,
        };
    }

    private childByName(parentUid: string, name: string): NodeRecord | undefined {
        return Object.values(this.state.nodes).find((node) => node.parentUid === parentUid && node.name === name && !node.trashed);
    }

    private require(uid: string): NodeRecord {
        const node = this.state.nodes[uid];
        if (!node) throw new NoSuchNodeError(`fake-drive: no node ${uid}`);
        return node;
    }

    /** Adds a node; it records the Drive event unless `quiet` (the caller records it later). */
    private insert(parentUid: string, name: string, type: 'file' | 'folder', content?: Content, quiet = false): NodeRecord {
        const now = new Date().toISOString();
        const uid = `${SCOPE_ID}~link-${this.state.nextId++}`;
        const node: NodeRecord = { uid, parentUid, name, type, created: now, modified: now, revisions: [] };
        this.state.nodes[uid] = node;
        if (content) this.appendRevision(node, content);
        if (!quiet) this.emit(DriveEventType.NodeCreated, node);
        return node;
    }

    private appendRevision(node: NodeRecord, content: Content): void {
        const now = new Date().toISOString();
        node.revisions.push({
            uid: `${node.uid}~rev-${this.state.nextId++}`,
            created: now,
            blob: this.writeBlob(content.content),
            size: content.content.length,
            declaredSize: content.declaredSize,
            mediaType: content.mediaType,
            claimedModificationTime: content.modificationTime?.toISOString(),
        });
        if (content.modificationTime) node.claimedModificationTime = content.modificationTime.toISOString();
        node.modified = now;
    }

    private emit(type: DriveEventType.NodeCreated | DriveEventType.NodeUpdated, node: NodeRecord): void {
        this.state.events.push({
            type,
            nodeUid: node.uid,
            parentNodeUid: node.parentUid,
            isTrashed: !!node.trashed,
            isShared: false,
            treeEventScopeId: SCOPE_ID,
            eventId: String(this.state.nextEventId++),
        });
    }
}

/** Checks the product's session before each Drive call, as the SDK's HTTP client does (account.ts). */
export type DriveAuthorizer = {
    /** Resolves when the product's access token is good, after a refresh if one is needed; throws otherwise. */
    authorize(): Promise<void>;
};

export type FakeDriveClientOptions = {
    /** The faults to raise (faults.ts). None when absent. */
    faults?: Faults;
    /** The clock the event scheduler polls on (clock.ts). When absent, it polls only when fired. */
    clock?: Clock;
    /** Checked first on every call (account.ts). When absent, every call is authorized. */
    account?: DriveAuthorizer;
    /** The requirement headers each call's response carries (requirements.ts). None when absent. */
    requirements?: Requirements;
};

/**
 * The SDK surface over a `FakeDrive`: what the product gets in place of `ProtonDriveClient`.
 * It gives every node, the ones the product must hide included (trashed, a name it cannot
 * decrypt, a file with no clear-text size), so the product's own filter is what hides them.
 *
 * Every call is counted, then checks the account, then meets its fault, if one is set.
 */
export class FakeDriveClient implements SdkSurface {
    private readonly schedulers = new Set<FakeScheduler>();
    private readonly counts: CallCounts = { methods: {}, listings: {}, nodeLoads: {}, downloads: {} };
    /** The calls that wait under an `upload-queued` fault, each by the function that gives it its turn. */
    private readonly waitingForTurn = new Set<() => void>();
    private readonly responseHooks: ResponseHook[] = [];
    private readonly crypto = new RealCrypto();

    constructor(
        private readonly drive: FakeDrive,
        private readonly options: FakeDriveClientOptions = {},
    ) {}

    calls(): CallCounts {
        return structuredClone(this.counts);
    }

    /** Ends the crypto workers the Drive's real crypto started, if it started any. */
    stop(): Promise<void> {
        return this.crypto.stop();
    }

    /**
     * Runs `hook` after each call, as ky runs an `afterResponse` hook, with a response that
     * carries the requirement headers set (requirements.ts). A call runs no hook while none is set.
     */
    onResponse(hook: ResponseHook): void {
        this.responseHooks.push(hook);
    }

    /** Polls every scope of every scheduler the product asked for, as the SDK's timer would. Returns the scopes polled. */
    async fireEventScheduler(): Promise<string[]> {
        const polled: string[] = [];
        for (const scheduler of this.schedulers) polled.push(...(await scheduler.pollNow()));
        return polled;
    }

    async getMyFilesRootFolder(): Promise<NodeEntity> {
        this.count('getMyFilesRootFolder');
        await this.enter('getMyFilesRootFolder', '');
        return this.entity(this.drive.rootUid);
    }

    async *iterateFolderChildrenNodeUids(parent: NodeOrUid, filterOptions?: { type?: NodeType }): AsyncGenerator<string> {
        this.count('iterateFolderChildrenNodeUids', 'listings', uidOf(parent));
        await this.enter('iterateFolderChildrenNodeUids', this.drive.pathOfUid(uidOf(parent)));
        // As the SDK: it loads the parent first, and the API filters by folder only.
        this.requireRecord(uidOf(parent));
        if (filterOptions?.type !== undefined && filterOptions.type !== NodeType.Folder) {
            throw Error('Filter options supports only folders');
        }
        const onlyFolders = filterOptions?.type === NodeType.Folder;
        for (const uid of this.drive.childUids(uidOf(parent))) {
            if (!onlyFolders || this.drive.record(uid)?.type === 'folder') yield uid;
        }
    }

    async *iterateNodes(uids: NodeOrUid[]): AsyncGenerator<MaybeMissingNode> {
        this.count('iterateNodes', 'nodeLoads', ...uids.map(uidOf));
        await this.enter('iterateNodes', ...uids.map((uid) => this.drive.pathOfUid(uidOf(uid))));
        if (!this.drive.realCrypto) {
            for (const uid of uids.map(uidOf)) {
                yield this.drive.record(uid) ? this.entity(uid) : { missingUid: uid };
            }
            return;
        }
        yield* mapConcurrently(uids.map(uidOf), DECRYPTION_CONCURRENCY, async (uid): Promise<MaybeMissingNode> => {
            if (!this.drive.record(uid)) return { missingUid: uid };
            await this.unlockNodeKey(uid);
            return this.entity(uid);
        });
    }

    async getNode(uid: NodeOrUid): Promise<NodeEntity> {
        this.count('getNode', 'nodeLoads', uidOf(uid));
        await this.enter('getNode', this.drive.pathOfUid(uidOf(uid)));
        if (this.drive.realCrypto) await this.unlockNodeKey(uidOf(uid));
        return this.entity(uidOf(uid));
    }

    async createFolder(parent: NodeOrUid, name: string, modificationTime?: Date): Promise<NodeEntity> {
        this.count('createFolder');
        await this.enter('createFolder', ...this.created(uidOf(parent), name));
        return this.entity(this.drive.createFolder(uidOf(parent), name, modificationTime));
    }

    async getFileUploader(parent: NodeOrUid, name: string, metadata: UploadMetadata, signal?: AbortSignal): Promise<FileUploader> {
        this.count('getFileUploader');
        const parentUid = uidOf(parent);
        const fault = await this.enter('getFileUploader', ...this.created(parentUid, name));
        await this.waitIfHeld(fault, signal);
        validateName(name);
        this.drive.checkFreeName(parentUid, name);
        return uploader(metadata, signal, (content) => this.drive.createFile(parentUid, name, content), this.upload(fault));
    }

    async getFileRevisionUploader(uid: NodeOrUid, metadata: UploadMetadata, signal?: AbortSignal): Promise<FileUploader> {
        this.count('getFileRevisionUploader');
        const nodeUid = uidOf(uid);
        const fault = await this.enter('getFileRevisionUploader', this.drive.pathOfUid(nodeUid));
        await this.waitIfHeld(fault, signal);
        this.requireRecord(nodeUid);
        return uploader(metadata, signal, (content) => this.drive.createRevision(nodeUid, content), this.upload(fault));
    }

    async getFileDownloader(uid: NodeOrUid, signal?: AbortSignal): Promise<FileDownloader> {
        this.count('getFileDownloader', 'downloads', uidOf(uid));
        const fault = await this.enter('getFileDownloader', this.drive.pathOfUid(uidOf(uid)));
        const node = this.requireRecord(uidOf(uid));
        const revision = node.revisions.at(-1);
        if (!revision) throw new ValidationError(`fake-drive: ${node.name} is not a file`);
        const stored = this.drive.revisionContent(revision);
        // With real crypto, the content comes once the file's node key has decrypted it.
        const content = this.drive.realCrypto ? this.crypto.download((await this.unlockNodeKey(node.uid))!, stored) : stored;
        // A downloader that is never read must not leave a failed decryption unhandled.
        if (content instanceof Promise) content.catch(() => {});
        const claimedSize = node.clearTextSize === false ? undefined : revision.size;
        // An integrity fault fails the download before its first byte.
        const failure = fault?.kind === 'integrity' ? faultError('integrity') : undefined;
        // As the SDK: one downloader downloads once, by either method.
        let started = false;
        const download = (writable: WritableStream): DownloadController => {
            if (started) throw new Error('Download already started');
            started = true;
            const done = failure ? Promise.reject(failure) : writeAll(content, writable, signal);
            // The caller may never await completion; keep a failure from being an unhandled rejection.
            done.catch(() => {});
            return { pause() {}, resume() {}, completion: () => done, isDownloadCompleteWithSignatureIssues: () => false };
        };
        return {
            getClaimedSizeInBytes: () => claimedSize,
            downloadToStream: download,
            unsafeDownloadToStream: download,
            getSeekableStream: () => (failure ? failingSeekable(failure) : seekable(content, this.drive.blockFetchMs)),
        };
    }

    async *trashNodes(uids: NodeOrUid[]): AsyncGenerator<NodeResult> {
        this.count('trashNodes');
        await this.enter('trashNodes', ...uids.map((uid) => this.drive.pathOfUid(uidOf(uid))));
        for (const uid of uids.map(uidOf)) {
            try {
                this.drive.trashNode(uid);
                yield { uid, ok: true };
            } catch (error: unknown) {
                yield { uid, ok: false, error: error as Error };
            }
        }
    }

    async *moveNodes(uids: NodeOrUid[], newParent: NodeOrUid): AsyncGenerator<NodeResult> {
        this.count('moveNodes');
        await this.enter('moveNodes', ...uids.map((uid) => this.drive.pathOfUid(uidOf(uid))));
        for (const uid of uids.map(uidOf)) {
            try {
                this.drive.moveNode(uid, uidOf(newParent));
                yield { uid, ok: true };
            } catch (error: unknown) {
                yield { uid, ok: false, error: error as Error };
            }
        }
    }

    async renameNode(uid: NodeOrUid, newName: string): Promise<NodeEntity> {
        this.count('renameNode');
        await this.enter('renameNode', this.drive.pathOfUid(uidOf(uid)));
        return this.entity(this.drive.renameNode(uidOf(uid), newName));
    }

    async getEventScheduler(callback: (scopeId: string) => Promise<void>): Promise<EventScheduler> {
        this.count('getEventScheduler');
        await this.enter('getEventScheduler', '');
        const scheduler = new FakeScheduler(callback, this.options.clock);
        this.schedulers.add(scheduler);
        // The SDK's EventScheduler is a class with private fields; this fake has its public methods.
        return scheduler as unknown as EventScheduler;
    }

    async *iterateEvents(scopeId: string, lastEventId?: string): AsyncGenerator<DriveEvent> {
        this.count('iterateEvents');
        await this.enter('iterateEvents', '');
        if (scopeId !== SCOPE_ID) return;
        if (lastEventId === undefined) {
            yield { type: DriveEventType.FastForward, treeEventScopeId: scopeId, eventId: this.drive.latestEventId() };
            return;
        }
        yield* this.drive.eventsAfter(lastEventId);
    }

    /**
     * What every call does after it is counted: it checks the account, passes the response hooks
     * the requirement headers set, then meets the first fault set for `operation` on one of
     * `targets`. A fault that is an error is thrown here; a fault the call acts on (`integrity`,
     * and the upload kinds) is returned.
     */
    private async enter(operation: Operation, ...targets: (string | undefined)[]): Promise<Fault | undefined> {
        await this.options.account?.authorize();
        await this.respond(operation);
        const fault = this.options.faults?.take(operation, targets);
        if (!fault || ACTED_ON.has(fault.kind)) return fault;
        throw faultError(fault.kind);
    }

    /** Passes each response hook a response that carries the requirement headers set, if any are. */
    private async respond(operation: Operation): Promise<void> {
        const headers = this.options.requirements?.headers();
        if (!headers) return;
        for (const hook of this.responseHooks) {
            await hook(new Request(`https://fake-drive.invalid/${operation}`), {}, new Response(null, { headers }));
        }
    }

    /** The targets of a call that creates `name` in the folder `parentUid`: the folder, and the new path. */
    private created(parentUid: string, name: string): (string | undefined)[] {
        const parent = this.drive.pathOfUid(parentUid);
        return [parent, parent === undefined ? undefined : parent ? `${parent}/${name}` : name];
    }

    /** What an upload needs besides its content: its fault, the clock, and how to count its start. */
    private upload(fault: Fault | undefined): UploadSetting {
        return { fault, clock: this.options.clock, started: () => this.count('uploadFromStream'), ended: () => this.uploadEnded() };
    }

    /**
     * Under an `upload-wait` fault, gives no uploader until `signal` aborts, then fails with
     * `AbortError`. Under an `upload-queued` fault, gives none until another upload ends, and fails
     * with `AbortError` if `signal` aborts first.
     */
    private async waitIfHeld(fault: Fault | undefined, signal: AbortSignal | undefined): Promise<void> {
        if (fault?.kind === 'upload-wait') {
            await untilAborted(signal);
            throw faultError('upload-wait');
        }
        if (fault?.kind !== 'upload-queued') return;
        let release!: () => void;
        const turn = new Promise<'turn'>((resolve) => (release = () => resolve('turn')));
        this.waitingForTurn.add(release);
        try {
            if ((await Promise.race([turn, untilAborted(signal).then(() => 'aborted' as const)])) === 'aborted') throw faultError('upload-queued');
        } finally {
            this.waitingForTurn.delete(release);
        }
    }

    /** An upload ended: each call that waits under an `upload-queued` fault gets its uploader. */
    private uploadEnded(): void {
        for (const release of this.waitingForTurn) release();
        this.waitingForTurn.clear();
    }

    private count(method: string, per?: Exclude<keyof CallCounts, 'methods'>, ...uids: string[]): void {
        this.counts.methods[method] = (this.counts.methods[method] ?? 0) + 1;
        if (!per) return;
        for (const uid of uids) this.counts[per][uid] = (this.counts[per][uid] ?? 0) + 1;
    }

    private requireRecord(uid: string): Readonly<NodeRecord> {
        const node = this.drive.record(uid);
        if (!node) throw new NoSuchNodeError(`fake-drive: no node ${uid}`);
        return node;
    }

    /** The unlocked node key of the file `uid` (real-crypto.ts). A folder has none here. */
    private async unlockNodeKey(uid: string): Promise<PrivateKeyReference | undefined> {
        const node = this.requireRecord(uid);
        return node.type === 'file' ? this.crypto.nodeKey(uid, armoredNodeKey(node.nodeKey)) : undefined;
    }

    /**
     * A file's `encryptedCrypto.armoredKey` is its node key, armored. The SDK's own nodes hold it
     * (`EncryptedNode.encryptedCrypto`) and its public `NodeEntity` leaves it out, so a product that
     * reads the key without unlocking it does so through a patch of the SDK that passes it on.
     */
    private entity(uid: string): NodeEntity {
        const node = this.requireRecord(uid);
        const author = { ok: true as const, value: OWNER };
        const active = node.revisions.at(-1);
        return {
            uid: node.uid,
            parentUid: node.parentUid,
            name: node.nameUndecryptable
                ? { ok: false, error: new DecryptionError('fake-drive: the name cannot be decrypted') }
                : { ok: true, value: node.name },
            keyAuthor: author,
            nameAuthor: author,
            directRole: MemberRole.Admin,
            ownedBy: { email: OWNER },
            type: node.type === 'file' ? NodeType.File : NodeType.Folder,
            mediaType: active?.mediaType,
            isShared: false,
            isSharedByUrl: false,
            creationTime: new Date(node.created),
            modificationTime: new Date(node.modified),
            trashTime: node.trashed ? new Date(node.trashed) : undefined,
            totalStorageSize: node.revisions.reduce((sum, revision) => sum + revision.size, 0),
            activeRevision: active && {
                uid: active.uid,
                state: RevisionState.Active,
                creationTime: new Date(active.created),
                contentAuthor: author,
                storageSize: active.size,
                isImported: false,
                claimedSize: node.clearTextSize === false ? undefined : active.size,
                claimedModificationTime: active.claimedModificationTime ? new Date(active.claimedModificationTime) : undefined,
            },
            folder:
                node.type === 'folder'
                    ? { isImported: false, claimedModificationTime: node.claimedModificationTime ? new Date(node.claimedModificationTime) : undefined }
                    : undefined,
            treeEventScopeId: SCOPE_ID,
            ...(node.type === 'file' ? { encryptedCrypto: { armoredKey: armoredNodeKey(node.nodeKey) } } : {}),
        };
    }
}

/**
 * Stands in for the SDK's `EventScheduler`. It polls when a scope is added and when fired. With a
 * clock, it also polls each scope `EVENT_POLL_MS` after its last poll ends, as the SDK's timer does
 * for the user's own volume. With no clock, it has no timer.
 */
class FakeScheduler {
    /** Each scope, and its timer for the next poll. */
    private readonly scopes = new Map<string, TimerHandle | undefined>();
    /** Each scope's poll in progress, so that the next one waits for it. */
    private readonly running = new Map<string, Promise<void>>();

    constructor(
        private readonly callback: (scopeId: string) => Promise<void>,
        private readonly clock?: Clock,
    ) {}

    addScope(scopeId: string): void {
        if (this.scopes.has(scopeId)) return;
        this.scopes.set(scopeId, undefined);
        void this.poll(scopeId);
    }

    setForeground(): void {}

    setBackground(): void {}

    removeScope(scopeId: string): void {
        this.clock?.clearTimeout(this.scopes.get(scopeId));
        this.scopes.delete(scopeId);
    }

    async pollNow(): Promise<string[]> {
        const scopes = [...this.scopes.keys()];
        for (const scopeId of scopes) await this.poll(scopeId);
        return scopes;
    }

    /**
     * As the SDK: a poll starts only once the poll before it ends, and the next timed poll is set
     * only once this one ends, so two polls never overlap.
     */
    private poll(scopeId: string): Promise<void> {
        const start = () => {
            this.clock?.clearTimeout(this.scopes.get(scopeId));
            return this.callback(scopeId).finally(() => {
                if (!this.clock || !this.scopes.has(scopeId)) return;
                this.scopes.set(scopeId, this.clock.setTimeout(() => this.poll(scopeId), EVENT_POLL_MS));
            });
        };
        const before = this.running.get(scopeId);
        const run = before ? before.then(start) : start();
        const settled = run.catch(() => {});
        this.running.set(scopeId, settled);
        void settled.then(() => {
            if (this.running.get(scopeId) === settled) this.running.delete(scopeId);
        });
        // A move of the clock waits for the poll, as for a timer it fired.
        if (this.clock instanceof FakeClock) this.clock.track(run);
        return run;
    }
}

/** The fault kinds a call acts on itself, rather than throwing their error when it is entered. */
const ACTED_ON: ReadonlySet<FaultKind> = new Set(['integrity', 'upload-part-way', 'upload-stall', 'upload-slow', 'upload-wait', 'upload-queued']);

/** How many parts an `upload-slow` fault reports, one each `SLOW_UPLOAD_STEP_MS` of the clock. */
export const SLOW_UPLOAD_STEPS = 10;
export const SLOW_UPLOAD_STEP_MS = 60_000;

type UploadSetting = { fault?: Fault; clock?: Clock; started: () => void; ended: () => void };

function uploader(
    metadata: UploadMetadata,
    signal: AbortSignal | undefined,
    commit: (content: Content) => { nodeUid: string; nodeRevisionUid: string },
    { fault, clock, started, ended }: UploadSetting,
): FileUploader {
    const upload = async (stream: ReadableStream, onProgress?: (uploadedBytes: number) => void): Promise<UploadController> => {
        started();
        // The slow upload's clock starts with the upload, before it reads a byte.
        const minutes = fault?.kind === 'upload-slow' ? slowly(clock, signal) : undefined;
        const done = (async () => {
            if (fault?.kind === 'upload-part-way') {
                // Read the first part of the content, then fail before the Drive commits anything.
                const reader = stream.getReader();
                await reader.read();
                await reader.cancel();
                throw faultError('upload-part-way');
            }
            if (fault?.kind === 'upload-stall') {
                // Read the first part of the content, then move no byte until the signal aborts.
                const reader = stream.getReader();
                await reader.read();
                await untilAborted(signal);
                await reader.cancel();
                throw faultError('upload-stall');
            }
            // A fake may buffer; the SDK encrypts block by block.
            const content = new Uint8Array(await new Response(stream).arrayBuffer());
            if (minutes) {
                const part = Math.ceil(content.length / SLOW_UPLOAD_STEPS);
                for (let step = 0; step < SLOW_UPLOAD_STEPS; step++) {
                    await minutes.next();
                    onProgress?.(Math.min(part, content.length - step * part));
                }
            } else {
                onProgress?.(content.length);
            }
            if (signal?.aborted) throw new AbortError('fake-drive: upload aborted');
            if (metadata.expectedSize !== null && content.length !== metadata.expectedSize) {
                throw new IntegrityError(`fake-drive: expected ${metadata.expectedSize} bytes, got ${content.length}`);
            }
            return commit({ content, mediaType: metadata.mediaType, declaredSize: metadata.expectedSize, modificationTime: metadata.modificationTime });
        })();
        // The caller may never await completion; keep an early failure from being an unhandled rejection.
        done.then(ended, ended);
        return { pause() {}, resume() {}, completion: () => done };
    };
    return {
        uploadFromStream: (stream, _thumbnails, onProgress) => upload(stream, onProgress),
        uploadFromFile: (file, _thumbnails, onProgress) => upload(file.stream(), onProgress),
    };
}

/**
 * The minutes of a slow upload: `next()` resolves at each `SLOW_UPLOAD_STEP_MS` of the clock, from
 * now, and rejects with `AbortError` once `signal` aborts. Each minute's timer is set when the last
 * one fires, so a move of the clock fires them in turn.
 */
function slowly(clock: Clock | undefined, signal: AbortSignal | undefined): { next(): Promise<void> } {
    if (!clock) {
        const missing = Promise.reject(new Error('fake-drive: an upload-slow fault needs the clock'));
        missing.catch(() => {});
        return { next: () => missing };
    }
    const ticks: Promise<void>[] = [];
    let handle: TimerHandle | undefined;
    let tick!: () => void;
    let fail!: (error: Error) => void;
    const arm = (count: number) => {
        if (count >= SLOW_UPLOAD_STEPS) return;
        const ticked = new Promise<void>((resolve, reject) => ((tick = resolve), (fail = reject)));
        ticked.catch(() => {});
        ticks.push(ticked);
        handle = clock.setTimeout(() => {
            tick();
            arm(count + 1);
        }, SLOW_UPLOAD_STEP_MS);
    };
    arm(0);
    signal?.addEventListener('abort', () => {
        clock.clearTimeout(handle);
        fail(new AbortError('fake-drive: upload aborted'));
    }, { once: true });
    let read = 0;
    return { next: () => ticks[read++] ?? Promise.reject(new AbortError('fake-drive: upload aborted')) };
}

/** Resolves once `signal` aborts; never, without one. */
function untilAborted(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
    });
}

/** Writes `content`, once it has come, in chunks. Like the SDK, it releases the writer's lock but never closes the stream. */
async function writeAll(pending: Uint8Array | Promise<Uint8Array>, writable: WritableStream, signal?: AbortSignal): Promise<void> {
    const content = await pending;
    const writer = writable.getWriter();
    for (let offset = 0; offset < content.length; offset += DOWNLOAD_CHUNK) {
        if (signal?.aborted) throw new AbortError('fake-drive: download aborted');
        await writer.write(content.slice(offset, offset + DOWNLOAD_CHUNK));
    }
    writer.releaseLock();
}

/**
 * The SDK's seekable stream over `content`, once it has come: `seek` to a byte, then `read` up to a
 * count of bytes. With `blockFetchMs`, it costs what the SDK's does in real time: a read fetches
 * the blocks it needs one after the other, `blockFetchMs` each, and keeps what is left of the last
 * one; a seek outside what it keeps starts again at the block of the new position. Streams fetch
 * at the same time without slowing each other.
 */
function seekable(pending: Uint8Array | Promise<Uint8Array>, blockFetchMs = 0): SeekableReadableStream {
    let position = 0;
    // The end of the bytes this stream has fetched, from the block of the last seek outside them.
    let fetchedTo = 0;
    const read = async (count: number) => {
        if (count <= 0) throw new Error('Invalid number of bytes to read');
        const content = await pending;
        const want = Math.min(position + count, content.length);
        while (blockFetchMs > 0 && fetchedTo < want) {
            await new Promise((resolve) => setTimeout(resolve, blockFetchMs));
            fetchedTo += BLOCK_SIZE;
        }
        const value = content.slice(position, position + count);
        position += value.length;
        return { value, done: position >= content.length };
    };
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { value, done } = await read(DOWNLOAD_CHUNK);
            if (value.length > 0) controller.enqueue(value);
            if (done) controller.close();
        },
        // Pull only when read: a pull ahead of time would move past a later `seek`.
    }, { highWaterMark: 0 });
    return Object.assign(stream, {
        read,
        seek: (to: number) => {
            if (to < position || to > fetchedTo) fetchedTo = Math.floor(to / BLOCK_SIZE) * BLOCK_SIZE;
            position = to;
        },
    });
}

/** A seekable stream whose first read fails with `error`, as a download that fails its integrity check. */
function failingSeekable(error: Error): SeekableReadableStream {
    const stream = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(error) }, { highWaterMark: 0 });
    return Object.assign(stream, {
        read: () => Promise.reject(error),
        seek: () => {},
    });
}

/** Throws as the SDK's `validateNodeName` does: a name must not be empty, nor longer than 255 characters. */
function validateName(name: string): void {
    if (!name) throw new ValidationError('fake-drive: Name must not be empty');
    if (name.length > MAX_NAME_LENGTH) throw new ValidationError(`fake-drive: Name must be ${MAX_NAME_LENGTH} characters long at most`);
}

function uidOf(value: NodeOrUid): string {
    return typeof value === 'string' ? value : value.uid;
}

function splitPath(path: string): string[] {
    return path.split('/').filter(Boolean);
}
