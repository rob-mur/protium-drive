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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
const NAME_TAKEN = 2500;
const MAX_NAME_LENGTH = 255;

/** `DIR/drive.json`. Dates are ISO 8601 strings. */
export type DriveState = {
    format: 1;
    rootUid: string;
    nextId: number;
    nextEventId: number;
    nodes: Record<string, NodeRecord>;
    events: DriveEvent[];
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

export type NodeInfo = Omit<NodeRecord, 'revisions'> & { path: string; mediaType?: string; revisionCount: number };
export type RevisionInfo = Omit<RevisionRecord, 'blob'> & { state: 'active' | 'superseded' };

/** What another client adds at a path. */
export type AddSpec =
    | { type: 'folder' }
    | { type: 'file'; content: Uint8Array; mediaType?: string; nameUndecryptable?: boolean; clearTextSize?: boolean };

/**
 * The calls the product made through one `FakeDriveClient`, kept in memory, not in `DIR`. A
 * generator method counts when the product starts to iterate it, as the SDK sends its request then.
 */
export type CallCounts = {
    /** Per SDK method. */
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
    private seen?: string;

    private constructor(private readonly dir: string) {}

    /** Opens the Drive kept in `dir`, and creates an empty one there if it holds none. */
    static open(dir: string): FakeDrive {
        mkdirSync(join(dir, 'blobs'), { recursive: true });
        const drive = new FakeDrive(dir);
        if (existsSync(drive.statePath)) {
            drive.reload();
        } else {
            const now = new Date().toISOString();
            const rootUid = `${SCOPE_ID}~link-1`;
            drive.state = { format: 1, rootUid, nextId: 2, nextEventId: 1, nodes: {}, events: [] };
            drive.state.nodes[rootUid] = { uid: rootUid, name: 'root', type: 'folder', created: now, modified: now, revisions: [] };
            drive.save();
        }
        return drive;
    }

    get rootUid(): string {
        this.sync();
        return this.state.rootUid;
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
            const content = { content: spec.content, mediaType: spec.mediaType ?? 'application/octet-stream', declaredSize: spec.content.length };
            const node = existing ?? this.insert(parent.uid, name, 'file', content, true);
            if (existing) {
                if (existing.type !== 'file') throw new ValidationError(`fake-drive: ${path} is a folder`);
                this.appendRevision(existing, content);
            }
            if (spec.nameUndecryptable !== undefined) node.nameUndecryptable = spec.nameUndecryptable;
            if (spec.clearTextSize !== undefined) node.clearTextSize = spec.clearTextSize;
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

    private get statePath(): string {
        return join(this.dir, 'drive.json');
    }

    /** Runs `fn` on the latest state and saves what it changed. When `fn` or the save throws, nothing changes. */
    private change<T>(fn: () => T): T {
        this.sync();
        try {
            const result = fn();
            this.save();
            return result;
        } catch (error: unknown) {
            this.reload();
            throw error;
        }
    }

    /** Reloads the state when another process saved it since this one last read or wrote it. */
    private sync(): void {
        if (this.stamp() !== this.seen) this.reload();
    }

    private reload(): void {
        this.state = JSON.parse(readFileSync(this.statePath, 'utf8')) as DriveState;
        if (this.state.format !== 1) throw new Error(`fake-drive: ${this.statePath} has format ${String(this.state.format)}, not 1`);
        this.seen = this.stamp();
    }

    private save(): void {
        const temporary = `${this.statePath}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`);
        renameSync(temporary, this.statePath);
        this.seen = this.stamp();
    }

    private stamp(): string | undefined {
        const stat = statSync(this.statePath, { throwIfNoEntry: false });
        return stat && `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
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
        return { ...rest, path: this.pathOf(node), mediaType: revisions.at(-1)?.mediaType, revisionCount: revisions.length };
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

/**
 * The SDK surface over a `FakeDrive`: what the product gets in place of `ProtonDriveClient`.
 * It gives every node, the ones the product must hide included (trashed, a name it cannot
 * decrypt, a file with no clear-text size), so the product's own filter is what hides them.
 */
export class FakeDriveClient implements SdkSurface {
    private readonly schedulers = new Set<FakeScheduler>();
    private readonly counts: CallCounts = { methods: {}, listings: {}, nodeLoads: {}, downloads: {} };

    constructor(private readonly drive: FakeDrive) {}

    calls(): CallCounts {
        return structuredClone(this.counts);
    }

    /** Polls every scope of every scheduler the product asked for, as the SDK's timer would. Returns the scopes polled. */
    async fireEventScheduler(): Promise<string[]> {
        const polled: string[] = [];
        for (const scheduler of this.schedulers) polled.push(...(await scheduler.pollNow()));
        return polled;
    }

    async getMyFilesRootFolder(): Promise<NodeEntity> {
        this.count('getMyFilesRootFolder');
        return this.entity(this.drive.rootUid);
    }

    async *iterateFolderChildrenNodeUids(parent: NodeOrUid, filterOptions?: { type?: NodeType }): AsyncGenerator<string> {
        this.count('iterateFolderChildrenNodeUids', 'listings', uidOf(parent));
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
        for (const uid of uids.map(uidOf)) {
            yield this.drive.record(uid) ? this.entity(uid) : { missingUid: uid };
        }
    }

    async getNode(uid: NodeOrUid): Promise<NodeEntity> {
        this.count('getNode', 'nodeLoads', uidOf(uid));
        return this.entity(uidOf(uid));
    }

    async createFolder(parent: NodeOrUid, name: string, modificationTime?: Date): Promise<NodeEntity> {
        this.count('createFolder');
        return this.entity(this.drive.createFolder(uidOf(parent), name, modificationTime));
    }

    async getFileUploader(parent: NodeOrUid, name: string, metadata: UploadMetadata, signal?: AbortSignal): Promise<FileUploader> {
        this.count('getFileUploader');
        const parentUid = uidOf(parent);
        validateName(name);
        this.drive.checkFreeName(parentUid, name);
        return uploader(metadata, signal, (content) => this.drive.createFile(parentUid, name, content));
    }

    async getFileRevisionUploader(uid: NodeOrUid, metadata: UploadMetadata, signal?: AbortSignal): Promise<FileUploader> {
        this.count('getFileRevisionUploader');
        const nodeUid = uidOf(uid);
        this.requireRecord(nodeUid);
        return uploader(metadata, signal, (content) => this.drive.createRevision(nodeUid, content));
    }

    async getFileDownloader(uid: NodeOrUid, signal?: AbortSignal): Promise<FileDownloader> {
        this.count('getFileDownloader', 'downloads', uidOf(uid));
        const node = this.requireRecord(uidOf(uid));
        const revision = node.revisions.at(-1);
        if (!revision) throw new ValidationError(`fake-drive: ${node.name} is not a file`);
        const content = this.drive.revisionContent(revision);
        const claimedSize = node.clearTextSize === false ? undefined : revision.size;
        // As the SDK: one downloader downloads once, by either method.
        let started = false;
        const download = (writable: WritableStream): DownloadController => {
            if (started) throw new Error('Download already started');
            started = true;
            const done = writeAll(content, writable, signal);
            return { pause() {}, resume() {}, completion: () => done, isDownloadCompleteWithSignatureIssues: () => false };
        };
        return {
            getClaimedSizeInBytes: () => claimedSize,
            downloadToStream: download,
            unsafeDownloadToStream: download,
            getSeekableStream: () => seekable(content),
        };
    }

    async *trashNodes(uids: NodeOrUid[]): AsyncGenerator<NodeResult> {
        this.count('trashNodes');
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
        return this.entity(this.drive.renameNode(uidOf(uid), newName));
    }

    async getEventScheduler(callback: (scopeId: string) => Promise<void>): Promise<EventScheduler> {
        this.count('getEventScheduler');
        const scheduler = new FakeScheduler(callback);
        this.schedulers.add(scheduler);
        // The SDK's EventScheduler is a class with private fields; this fake has its public methods.
        return scheduler as unknown as EventScheduler;
    }

    async *iterateEvents(scopeId: string, lastEventId?: string): AsyncGenerator<DriveEvent> {
        this.count('iterateEvents');
        if (scopeId !== SCOPE_ID) return;
        if (lastEventId === undefined) {
            yield { type: DriveEventType.FastForward, treeEventScopeId: scopeId, eventId: this.drive.latestEventId() };
            return;
        }
        yield* this.drive.eventsAfter(lastEventId);
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
        };
    }
}

/** Stands in for the SDK's `EventScheduler`. It polls when a scope is added, then only when fired: no timer. */
class FakeScheduler {
    private readonly scopes = new Set<string>();

    constructor(private readonly callback: (scopeId: string) => Promise<void>) {}

    addScope(scopeId: string): void {
        if (this.scopes.has(scopeId)) return;
        this.scopes.add(scopeId);
        void this.callback(scopeId);
    }

    setForeground(): void {}

    setBackground(): void {}

    removeScope(scopeId: string): void {
        this.scopes.delete(scopeId);
    }

    async pollNow(): Promise<string[]> {
        const scopes = [...this.scopes];
        for (const scopeId of scopes) await this.callback(scopeId);
        return scopes;
    }
}

function uploader(
    metadata: UploadMetadata,
    signal: AbortSignal | undefined,
    commit: (content: Content) => { nodeUid: string; nodeRevisionUid: string },
): FileUploader {
    const upload = async (stream: ReadableStream): Promise<UploadController> => {
        const done = (async () => {
            // A fake may buffer; the SDK encrypts block by block.
            const content = new Uint8Array(await new Response(stream).arrayBuffer());
            if (signal?.aborted) throw new AbortError('fake-drive: upload aborted');
            if (metadata.expectedSize !== null && content.length !== metadata.expectedSize) {
                throw new IntegrityError(`fake-drive: expected ${metadata.expectedSize} bytes, got ${content.length}`);
            }
            return commit({ content, mediaType: metadata.mediaType, declaredSize: metadata.expectedSize, modificationTime: metadata.modificationTime });
        })();
        // The caller may never await completion; keep an early failure from being an unhandled rejection.
        done.catch(() => {});
        return { pause() {}, resume() {}, completion: () => done };
    };
    return { uploadFromStream: upload, uploadFromFile: (file: File) => upload(file.stream()) };
}

/** Writes `content` in chunks. Like the SDK, it releases the writer's lock but never closes the stream. */
async function writeAll(content: Uint8Array, writable: WritableStream, signal?: AbortSignal): Promise<void> {
    const writer = writable.getWriter();
    for (let offset = 0; offset < content.length; offset += DOWNLOAD_CHUNK) {
        if (signal?.aborted) throw new AbortError('fake-drive: download aborted');
        await writer.write(content.slice(offset, offset + DOWNLOAD_CHUNK));
    }
    writer.releaseLock();
}

/** The SDK's seekable stream over `content`: `seek` to a byte, then `read` up to a count of bytes. */
function seekable(content: Uint8Array): SeekableReadableStream {
    let position = 0;
    const read = async (count: number) => {
        if (count <= 0) throw new Error('Invalid number of bytes to read');
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
            position = to;
        },
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
