import { type DriveEvent, DriveEventType, type Logger, type NodeEntity } from '@protontech/drive-sdk';

import { Backoff } from './backoff';
import { openDownload, type ByteRange } from './download';
import { type Entry, isSkipped, toEntry } from './entry';
import { conflict, DriveError, notFound } from './errors';
import type { DriveSdk } from './sdk';

export type UploadOptions = {
    /** Clear-text size from `Content-Length`, or `null` when the client streams without one. */
    size: number | null;
    mediaType: string;
    modified?: Date;
};

type Listing = Map<string, Entry>;

/**
 * Proton Drive as a tree of paths, on top of the SDK's node UIDs.
 *
 * Folder listings are cached by folder UID and loaded only when a client asks
 * for them; nothing walks the tree in the background. Drive events (see
 * `EventWatcher`) drop the listings they touch, so the next request reloads
 * only those folders. Writes made through this class update the cache at once.
 */
export class DriveTree {
    private rootEntry?: Promise<Entry>;
    private readonly listings = new Map<string, Promise<Listing>>();
    /** Folder UID that each cached entry was listed in. */
    private readonly parentOf = new Map<string, string>();

    constructor(
        private readonly sdk: DriveSdk,
        private readonly logger: Logger,
        private readonly options: { rootPath?: string[] } = {},
        readonly backoff = new Backoff(),
    ) {}

    /** The served root: My files, or the `--root` folder inside it. */
    root(): Promise<Entry> {
        this.rootEntry ??= this.loadRoot().catch((error: unknown) => {
            this.rootEntry = undefined;
            throw error;
        });
        return this.rootEntry;
    }

    /** Resolves path segments below the root. Returns `undefined` when a segment does not exist. */
    async stat(segments: string[]): Promise<Entry | undefined> {
        return this.resolveFrom(await this.root(), segments);
    }

    async list(folder: Entry): Promise<Entry[]> {
        if (folder.kind !== 'folder') {
            throw new DriveError(400, `${folder.name} is not a folder`);
        }
        return [...(await this.listing(folder.uid)).values()];
    }

    async createFolder(parentSegments: string[], name: string): Promise<Entry> {
        const parent = await this.requireFolder(parentSegments);
        const listing = await this.listing(parent.uid);
        if (listing.has(name)) {
            throw new DriveError(405, `${name} already exists`);
        }
        const node = await this.backoff.run(() => this.sdk.createFolder(parent.uid, name));
        return this.remember(parent.uid, node);
    }

    /**
     * Uploads a file. A new name creates a file; an existing file gets a new
     * revision, so Proton keeps the old content in the file's history.
     */
    async upload(
        parentSegments: string[],
        name: string,
        body: ReadableStream<Uint8Array>,
        options: UploadOptions,
        signal?: AbortSignal,
    ): Promise<{ entry: Entry; created: boolean }> {
        const parent = await this.requireFolder(parentSegments);
        const existing = (await this.listing(parent.uid)).get(name);
        if (existing?.kind === 'folder') {
            throw new DriveError(405, `${name} is a folder`);
        }
        const metadata = {
            mediaType: options.mediaType,
            expectedSize: options.size,
            modificationTime: options.modified,
        };
        const result = await this.backoff.run(async () => {
            const uploader = existing
                ? await this.sdk.getFileRevisionUploader(existing.uid, metadata, signal)
                : await this.sdk.getFileUploader(parent.uid, name, metadata, signal);
            const controller = await uploader.uploadFromStream(body, []);
            return controller.completion();
        });
        const node = await this.backoff.run(() => this.sdk.getNode(result.nodeUid));
        return { entry: this.remember(parent.uid, node), created: !existing };
    }

    /** Streams a file. `signal` is the client's request; when it aborts, the download stops. */
    async read(file: Entry, range?: ByteRange, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
        if (file.kind !== 'file') {
            throw new DriveError(405, `${file.name} is a folder`);
        }
        this.backoff.check();
        return openDownload(this.sdk, file, {
            range,
            signal,
            logger: this.logger,
            onError: (error) => this.backoff.note(error),
        });
    }

    /** Moves the entry to Proton's trash. Nothing is deleted for good. */
    async trash(segments: string[]): Promise<void> {
        const entry = await this.requireEntry(segments);
        if (segments.length === 0) {
            throw new DriveError(403, 'The root folder cannot be deleted');
        }
        for await (const result of await this.backoff.run(async () => collect(this.sdk.trashNodes([entry.uid])))) {
            if (!result.ok) {
                throw result.error;
            }
        }
        this.forget(entry.uid);
    }

    /** Moves and/or renames. With `overwrite`, an existing target goes to the trash first. */
    async move(fromSegments: string[], toSegments: string[], overwrite: boolean): Promise<{ created: boolean }> {
        if (fromSegments.length === 0 || toSegments.length === 0) {
            throw new DriveError(403, 'The root folder cannot be moved');
        }
        if (isPrefix(fromSegments, toSegments)) {
            throw new DriveError(409, 'Cannot move a folder into itself');
        }
        if (isPrefix(toSegments, fromSegments)) {
            // With Overwrite, this would trash the folder that holds the source.
            throw new DriveError(409, 'Cannot move an entry onto a folder that contains it');
        }
        const entry = await this.requireEntry(fromSegments);
        const fromParentUid = entry.parentUid ?? this.parentOf.get(entry.uid);
        const toParent = await this.requireFolder(toSegments.slice(0, -1));
        const newName = toSegments[toSegments.length - 1];
        const target = (await this.listing(toParent.uid)).get(newName);
        if (target?.uid === entry.uid) {
            return { created: false };
        }
        if (target) {
            if (!overwrite) {
                throw new DriveError(412, `${newName} already exists`);
            }
            await this.trash(toSegments);
        }

        try {
            if (fromParentUid !== toParent.uid) {
                for await (const result of await this.backoff.run(async () =>
                    collect(this.sdk.moveNodes([entry.uid], toParent.uid)),
                )) {
                    if (!result.ok) {
                        throw result.error;
                    }
                }
            }
            if (entry.name !== newName) {
                await this.backoff.run(() => this.sdk.renameNode(entry.uid, newName));
            }
        } finally {
            // Also after a half-done move (moved, but the rename failed).
            this.forget(entry.uid);
            if (fromParentUid) {
                this.listings.delete(fromParentUid);
            }
            this.listings.delete(toParent.uid);
        }
        return { created: !target };
    }

    /** Applies one Drive event to the cache. */
    applyEvent(event: DriveEvent): void {
        switch (event.type) {
            case DriveEventType.TreeRefresh:
            case DriveEventType.TreeRemove:
                this.logger.info(`Drive event ${event.type}: dropping all cached listings`);
                this.clear();
                return;
            case DriveEventType.NodeCreated:
            case DriveEventType.NodeUpdated:
            case DriveEventType.NodeDeleted:
                this.forget(event.nodeUid);
                if (event.parentNodeUid) {
                    this.listings.delete(event.parentNodeUid);
                }
                return;
            default:
                return;
        }
    }

    clear(): void {
        this.listings.clear();
        this.parentOf.clear();
    }

    /** Number of cached folder listings; for tests and logs. */
    get cachedListingCount(): number {
        return this.listings.size;
    }

    private async loadRoot(): Promise<Entry> {
        const node = await this.backoff.run(() => this.sdk.getMyFilesRootFolder());
        const myFiles = toEntry(node);
        if (isSkipped(myFiles)) {
            throw new Error(`My files root cannot be used: ${myFiles.skipped}`);
        }
        const rootPath = this.options.rootPath ?? [];
        const entry = await this.resolveFrom(myFiles, rootPath);
        if (!entry || entry.kind !== 'folder') {
            throw new DriveError(500, `Root folder /${rootPath.join('/')} does not exist in My files`);
        }
        return entry;
    }

    private async resolveFrom(start: Entry, segments: string[]): Promise<Entry | undefined> {
        let current = start;
        for (const segment of segments) {
            if (current.kind !== 'folder') {
                return undefined;
            }
            const next = (await this.listing(current.uid)).get(segment);
            if (!next) {
                return undefined;
            }
            current = next;
        }
        return current;
    }

    private async requireEntry(segments: string[]): Promise<Entry> {
        const entry = await this.stat(segments);
        if (!entry) {
            throw notFound(`/${segments.join('/')}`);
        }
        return entry;
    }

    private async requireFolder(segments: string[]): Promise<Entry> {
        const entry = await this.stat(segments);
        if (!entry || entry.kind !== 'folder') {
            throw conflict(`Parent folder /${segments.join('/')} does not exist`);
        }
        return entry;
    }

    private listing(folderUid: string): Promise<Listing> {
        let pending = this.listings.get(folderUid);
        if (!pending) {
            pending = this.loadListing(folderUid);
            this.listings.set(folderUid, pending);
            pending.catch(() => {
                if (this.listings.get(folderUid) === pending) {
                    this.listings.delete(folderUid);
                }
            });
        }
        return pending;
    }

    private async loadListing(folderUid: string): Promise<Listing> {
        return this.backoff.run(async () => {
            const uids: string[] = [];
            for await (const uid of this.sdk.iterateFolderChildrenNodeUids(folderUid)) {
                uids.push(uid);
            }
            const listing: Listing = new Map();
            if (uids.length === 0) {
                return listing;
            }
            for await (const node of this.sdk.iterateNodes(uids)) {
                if ('missingUid' in node) {
                    continue;
                }
                const entry = toEntry(node);
                if (isSkipped(entry)) {
                    if (entry.skipped !== 'trashed') {
                        this.logger.warn(`Skipping node ${node.uid}: ${entry.skipped}`);
                    }
                    continue;
                }
                listing.set(entry.name, entry);
                this.parentOf.set(entry.uid, folderUid);
            }
            this.logger.debug(`Listed folder ${folderUid}: ${listing.size} entries`);
            return listing;
        });
    }

    /** Stores a node we just created or changed in its parent's cached listing. */
    private remember(parentUid: string, node: NodeEntity): Entry {
        const entry = toEntry(node);
        if (isSkipped(entry)) {
            this.listings.delete(parentUid);
            throw new DriveError(502, `Proton returned a node that cannot be served: ${entry.skipped}`);
        }
        const cached = this.listings.get(parentUid);
        if (cached) {
            void cached.then((listing) => listing.set(entry.name, entry)).catch(() => {});
        }
        this.parentOf.set(entry.uid, parentUid);
        return entry;
    }

    /** Drops an entry from its parent listing, and its own listing if it is a folder. */
    private forget(uid: string): void {
        const parentUid = this.parentOf.get(uid);
        if (parentUid) {
            this.listings.delete(parentUid);
        }
        this.parentOf.delete(uid);
        this.listings.delete(uid);
    }
}

async function collect<T>(iterator: AsyncGenerator<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of iterator) {
        items.push(item);
    }
    return items;
}

function isPrefix(prefix: string[], segments: string[]): boolean {
    return prefix.length < segments.length && prefix.every((segment, index) => segments[index] === segment);
}
