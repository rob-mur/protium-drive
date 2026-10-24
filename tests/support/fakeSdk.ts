import {
    AbortError,
    type DriveEvent,
    DriveEventType,
    type EventScheduler,
    type FileDownloader,
    type FileUploader,
    IntegrityError,
    type MaybeMissingNode,
    type NodeEntity,
    type NodeResult,
    NodeType,
    NodeWithSameNameExistsValidationError,
    RateLimitedError,
    type UploadMetadata,
    ValidationError,
} from '@protontech/drive-sdk';

import type { DriveSdk } from '../../src/drive/sdk';

export const SCOPE_ID = 'volume-1';
const DOWNLOAD_CHUNK = 64 * 1024;

type FakeNode = {
    uid: string;
    parentUid?: string;
    name: string;
    type: NodeType;
    created: Date;
    modified: Date;
    trashed?: Date;
    content?: Uint8Array;
    mediaType?: string;
    revision: number;
    /** Old revisions without block sizes cannot seek in the real SDK. */
    legacy?: boolean;
    /** Makes the next download fail its signature check after all bytes. */
    corrupt?: boolean;
};

/**
 * In-memory stand-in for `ProtonDriveClient`, with the behaviour the server
 * depends on: node UIDs, revisions, trash, name conflicts, events, a limited
 * number of download slots, and the SDK's stream quirks (the downloader never
 * closes the target stream).
 */
export class FakeDriveSdk implements DriveSdk {
    readonly nodes = new Map<string, FakeNode>();
    readonly events: DriveEvent[] = [];
    readonly calls: Record<string, number> = {};
    readonly rootUid: string;
    /** Downloads that hold a slot right now. Must return to 0 after every request. */
    activeDownloads = 0;
    readonly maxDownloads = 5;
    /** The next N calls throw `RateLimitedError`. */
    rateLimitCalls = 0;
    /** Delay in `getFileDownloader`, like waiting for a slot and loading keys. */
    downloaderDelayMs = 0;
    scheduler?: FakeScheduler;
    private nextId = 1;
    private nextEventId = 1;

    constructor() {
        this.rootUid = this.addNode({ name: 'root', type: NodeType.Folder });
    }

    // --- test helpers -----------------------------------------------------

    /** Creates folders and a file at `path`, as another device would, and records events. */
    remoteWrite(path: string, content: string | Uint8Array, options: Partial<FakeNode> = {}): string {
        const segments = path.split('/').filter(Boolean);
        const parentUid = this.remoteMkdirp(segments.slice(0, -1));
        const name = segments[segments.length - 1];
        const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        const existing = this.childByName(parentUid, name);
        if (existing) {
            existing.content = bytes;
            existing.revision++;
            existing.modified = new Date();
            Object.assign(existing, options);
            this.emit(DriveEventType.NodeUpdated, existing);
            return existing.uid;
        }
        const uid = this.addNode({ parentUid, name, type: NodeType.File, content: bytes, ...options });
        this.emit(DriveEventType.NodeCreated, this.nodes.get(uid)!);
        return uid;
    }

    remoteMkdirp(segments: string[]): string {
        let parentUid = this.rootUid;
        for (const name of segments) {
            const existing = this.childByName(parentUid, name);
            if (existing) {
                parentUid = existing.uid;
                continue;
            }
            parentUid = this.addNode({ parentUid, name, type: NodeType.Folder });
            this.emit(DriveEventType.NodeCreated, this.nodes.get(parentUid)!);
        }
        return parentUid;
    }

    remoteTrash(path: string): void {
        const node = this.byPath(path);
        node.trashed = new Date();
        this.emit(DriveEventType.NodeUpdated, node);
    }

    byPath(path: string): FakeNode {
        let node = this.nodes.get(this.rootUid)!;
        for (const name of path.split('/').filter(Boolean)) {
            const child = this.childByName(node.uid, name);
            if (!child) {
                throw new Error(`fake: no ${path}`);
            }
            node = child;
        }
        return node;
    }

    text(path: string): string {
        return new TextDecoder().decode(this.byPath(path).content);
    }

    trashedNames(): string[] {
        return [...this.nodes.values()].filter((n) => n.trashed).map((n) => n.name);
    }

    count(method: string): number {
        return this.calls[method] ?? 0;
    }

    // --- DriveSdk ---------------------------------------------------------

    async getMyFilesRootFolder(): Promise<NodeEntity> {
        this.enter('getMyFilesRootFolder');
        return this.entity(this.nodes.get(this.rootUid)!);
    }

    async *iterateFolderChildrenNodeUids(parent: unknown): AsyncGenerator<string> {
        this.enter('iterateFolderChildrenNodeUids');
        const parentUid = uidOf(parent);
        for (const node of this.nodes.values()) {
            if (node.parentUid === parentUid) {
                yield node.uid;
            }
        }
    }

    async *iterateNodes(uids: unknown[]): AsyncGenerator<MaybeMissingNode> {
        this.enter('iterateNodes');
        for (const uid of uids.map(uidOf)) {
            const node = this.nodes.get(uid);
            yield node ? this.entity(node) : { missingUid: uid };
        }
    }

    async getNode(uid: unknown): Promise<NodeEntity> {
        this.enter('getNode');
        return this.entity(this.require(uidOf(uid)));
    }

    async createFolder(parent: unknown, name: string): Promise<NodeEntity> {
        this.enter('createFolder');
        const parentUid = uidOf(parent);
        this.checkFreeName(parentUid, name);
        const uid = this.addNode({ parentUid, name, type: NodeType.Folder });
        const node = this.nodes.get(uid)!;
        this.emit(DriveEventType.NodeCreated, node);
        return this.entity(node);
    }

    async getFileUploader(parent: unknown, name: string, metadata: UploadMetadata, signal?: AbortSignal): Promise<FileUploader> {
        this.enter('getFileUploader');
        const parentUid = uidOf(parent);
        this.checkFreeName(parentUid, name);
        return this.uploader(metadata, signal, (content) => {
            this.checkFreeName(parentUid, name);
            const uid = this.addNode({ parentUid, name, type: NodeType.File, content, mediaType: metadata.mediaType });
            const node = this.nodes.get(uid)!;
            if (metadata.modificationTime) {
                node.modified = metadata.modificationTime;
            }
            this.emit(DriveEventType.NodeCreated, node);
            return node;
        });
    }

    async getFileRevisionUploader(uid: unknown, metadata: UploadMetadata, signal?: AbortSignal): Promise<FileUploader> {
        this.enter('getFileRevisionUploader');
        const node = this.require(uidOf(uid));
        return this.uploader(metadata, signal, (content) => {
            node.content = content;
            node.revision++;
            node.modified = metadata.modificationTime ?? new Date();
            node.mediaType = metadata.mediaType;
            node.legacy = false;
            this.emit(DriveEventType.NodeUpdated, node);
            return node;
        });
    }

    /**
     * Like the SDK: a slot is freed when `downloadToStream` ends, or when the
     * signal aborts after `getSeekableStream`. Aborting alone does not end a
     * `downloadToStream` whose writer waits for its reader.
     */
    async getFileDownloader(uid: unknown, signal?: AbortSignal): Promise<FileDownloader> {
        this.enter('getFileDownloader');
        const node = this.require(uidOf(uid));
        if (this.downloaderDelayMs > 0) {
            await Bun.sleep(this.downloaderDelayMs);
        }
        if (signal?.aborted) {
            throw new AbortError('fake: aborted while waiting for a slot');
        }
        if (this.activeDownloads >= this.maxDownloads) {
            throw new Error('fake: all download slots are taken (a slot leaked)');
        }
        const content = node.content ?? new Uint8Array();
        const corrupt = node.corrupt;
        const legacy = node.legacy;
        this.activeDownloads++;
        let released = false;
        const release = () => {
            if (!released) {
                released = true;
                this.activeDownloads--;
            }
        };

        return {
            getClaimedSizeInBytes: () => content.length,
            downloadToStream: (writable: WritableStream) => {
                const done = (async () => {
                    const writer = writable.getWriter();
                    try {
                        for (let offset = 0; offset < content.length; offset += DOWNLOAD_CHUNK) {
                            if (signal?.aborted) {
                                throw new AbortError('fake: aborted');
                            }
                            await writer.write(content.slice(offset, offset + DOWNLOAD_CHUNK));
                        }
                        if (corrupt) {
                            throw new IntegrityError('fake: manifest signature does not match');
                        }
                        // Like the SDK: release the lock, but never close the stream.
                        writer.releaseLock();
                    } finally {
                        release();
                    }
                })();
                return { pause() {}, resume() {}, completion: () => done } as never;
            },
            unsafeDownloadToStream: () => {
                throw new Error('fake: unsafeDownloadToStream is not used');
            },
            getSeekableStream: () => {
                if (legacy) {
                    throw new Error('fake: revision has no block sizes');
                }
                signal?.addEventListener('abort', release, { once: true });
                let position = 0;
                return {
                    seek: async (to: number) => {
                        position = to;
                    },
                    read: async (count: number) => {
                        const value = content.slice(position, position + count);
                        position += value.length;
                        return { value, done: position >= content.length };
                    },
                } as never;
            },
        };
    }

    async *trashNodes(uids: unknown[]): AsyncGenerator<NodeResult> {
        this.enter('trashNodes');
        for (const uid of uids.map(uidOf)) {
            const node = this.require(uid);
            node.trashed = new Date();
            this.emit(DriveEventType.NodeUpdated, node);
            yield { uid, ok: true };
        }
    }

    async *moveNodes(uids: unknown[], newParent: unknown): AsyncGenerator<NodeResult> {
        this.enter('moveNodes');
        const parentUid = uidOf(newParent);
        for (const uid of uids.map(uidOf)) {
            const node = this.require(uid);
            if (this.childByName(parentUid, node.name)) {
                yield { uid, ok: false, error: new NodeWithSameNameExistsValidationError('fake: name taken', 2500) };
                continue;
            }
            node.parentUid = parentUid;
            this.emit(DriveEventType.NodeUpdated, node);
            yield { uid, ok: true };
        }
    }

    async renameNode(uid: unknown, newName: string): Promise<NodeEntity> {
        this.enter('renameNode');
        const node = this.require(uidOf(uid));
        if (node.parentUid && this.childByName(node.parentUid, newName)) {
            throw new ValidationError('fake: a node with this name already exists', 2500);
        }
        node.name = newName;
        this.emit(DriveEventType.NodeUpdated, node);
        return this.entity(node);
    }

    async getEventScheduler(callback: (scopeId: string) => Promise<void>): Promise<EventScheduler> {
        this.enter('getEventScheduler');
        this.scheduler = new FakeScheduler(callback);
        return this.scheduler as unknown as EventScheduler;
    }

    async *iterateEvents(scopeId: string, lastEventId?: string): AsyncGenerator<DriveEvent> {
        this.enter('iterateEvents');
        const latest = String(this.nextEventId - 1);
        if (!lastEventId) {
            yield { type: DriveEventType.FastForward, treeEventScopeId: scopeId, eventId: latest };
            return;
        }
        for (const event of this.events) {
            if (Number(event.eventId) > Number(lastEventId)) {
                yield event;
            }
        }
    }

    // --- internals --------------------------------------------------------

    private enter(method: string): void {
        this.calls[method] = (this.calls[method] ?? 0) + 1;
        if (this.rateLimitCalls > 0) {
            this.rateLimitCalls--;
            throw new RateLimitedError('fake: too many requests');
        }
    }

    private uploader(
        metadata: UploadMetadata,
        signal: AbortSignal | undefined,
        commit: (content: Uint8Array) => FakeNode,
    ): FileUploader {
        return {
            uploadFromStream: async (stream: ReadableStream) => {
                const done = (async () => {
                    // A fake may buffer; the real SDK encrypts block by block.
                    const content = new Uint8Array(await new Response(stream).arrayBuffer());
                    if (signal?.aborted) {
                        throw new AbortError('fake: upload aborted');
                    }
                    if (metadata.expectedSize !== null && content.length !== metadata.expectedSize) {
                        throw new IntegrityError(
                            `fake: expected ${metadata.expectedSize} bytes, got ${content.length}`,
                        );
                    }
                    const node = commit(content);
                    return { nodeUid: node.uid, nodeRevisionUid: `${node.uid}~r${node.revision}` };
                })();
                return { pause() {}, resume() {}, completion: () => done } as never;
            },
            uploadFromFile: async () => {
                throw new Error('fake: uploadFromFile is not used');
            },
        } as FileUploader;
    }

    private addNode(fields: Pick<FakeNode, 'name' | 'type'> & Partial<FakeNode>): string {
        const uid = `node-${this.nextId++}`;
        const now = new Date();
        this.nodes.set(uid, { uid, created: now, modified: now, revision: 1, ...fields });
        return uid;
    }

    private childByName(parentUid: string, name: string): FakeNode | undefined {
        for (const node of this.nodes.values()) {
            if (node.parentUid === parentUid && node.name === name && !node.trashed) {
                return node;
            }
        }
        return undefined;
    }

    private checkFreeName(parentUid: string, name: string): void {
        const existing = this.childByName(parentUid, name);
        if (existing) {
            throw new NodeWithSameNameExistsValidationError('fake: name taken', 2500, existing.uid, false);
        }
    }

    private require(uid: string): FakeNode {
        const node = this.nodes.get(uid);
        if (!node) {
            throw new ValidationError(`fake: no node ${uid}`);
        }
        return node;
    }

    private emit(type: DriveEventType.NodeCreated | DriveEventType.NodeUpdated, node: FakeNode): void {
        this.events.push({
            type,
            nodeUid: node.uid,
            parentNodeUid: node.parentUid,
            isTrashed: !!node.trashed,
            isShared: false,
            treeEventScopeId: SCOPE_ID,
            eventId: String(this.nextEventId++),
        });
    }

    private entity(node: FakeNode): NodeEntity {
        const isFile = node.type === NodeType.File;
        return {
            uid: node.uid,
            parentUid: node.parentUid,
            name: { ok: true, value: node.name },
            type: node.type,
            mediaType: node.mediaType,
            creationTime: node.created,
            modificationTime: node.modified,
            trashTime: node.trashed,
            treeEventScopeId: SCOPE_ID,
            activeRevision: isFile
                ? {
                      uid: `${node.uid}~r${node.revision}`,
                      claimedSize: node.content?.length ?? 0,
                      claimedModificationTime: node.modified,
                  }
                : undefined,
        } as unknown as NodeEntity;
    }
}

/** Stand-in for the SDK's `EventScheduler`; tests call `pollNow()` instead of waiting 30 s. */
export class FakeScheduler {
    readonly scopes = new Set<string>();

    constructor(private readonly callback: (scopeId: string) => Promise<void>) {}

    addScope(scopeId: string): void {
        this.scopes.add(scopeId);
        void this.callback(scopeId);
    }

    removeScope(scopeId: string): void {
        this.scopes.delete(scopeId);
    }

    async pollNow(): Promise<void> {
        for (const scopeId of this.scopes) {
            await this.callback(scopeId);
        }
    }
}

function uidOf(value: unknown): string {
    return typeof value === 'string' ? value : (value as { uid: string }).uid;
}
