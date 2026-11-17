import type { NodeEntity } from '@protontech/drive-sdk';

import type { Logger } from '../../vendor/proton-drive-sdk-account';

import { Backoff } from './backoff';
import { openDownload, type ByteRange } from './download';
import { type Entry, isSkipped, toEntry } from './entry';
import { DriveError } from './errors';
import type { ListingSnapshot } from './listing-cache';
import type { DriveSdk } from './sdk';

/** One folder's children, by name. */
type Listing = Map<string, Entry>;

/** What the client declared about the file it uploads. */
export type UploadOptions = {
    /** Clear-text size in bytes, from `Content-Length`; `undefined` when unknown. */
    size?: number;
    mediaType: string;
    /** The file's own modification time, from `X-OC-Mtime`. */
    modified?: Date;
};

export type DriveTreeOptions = {
    /**
     * The folder of My files to serve as the root (`--root`), as path
     * segments. When set, every path the tree answers is relative to it, and
     * the first ask that finds it missing fails naming it.
     */
    rootPath?: string[];
    /**
     * Listings a previous serve saved. They are installed once My files'
     * root is known, and only when the snapshot was taken of that root and
     * its event scope; otherwise they are ignored.
     */
    restore?: ListingSnapshot;
};

/**
 * Proton Drive as a tree of paths, on top of the SDK's node UIDs.
 *
 * A folder's listing loads only when a client asks for it and stays cached by
 * folder UID, so repeated stats and listings cost no Drive calls and nothing
 * walks the tree in the background. A failed listing is not cached, so the
 * next ask loads the folder again. The loaded listings can be saved with
 * `snapshot()` and handed to the next serve as `restore`.
 */
export class DriveTree {
    private rootEntry?: Promise<Entry>;
    private readonly listings = new Map<string, Promise<Listing>>();
    /** The listings that finished loading, by the promise `listings` holds for them. */
    private readonly loaded = new WeakMap<Promise<Listing>, Listing>();
    private myFilesRoot?: Entry;
    private pendingRestore?: ListingSnapshot;
    private restoredFrom?: string;
    private loads = 0;

    constructor(
        private readonly sdk: DriveSdk,
        private readonly logger: Logger,
        readonly backoff: Backoff = new Backoff(),
        private readonly options: DriveTreeOptions = {},
    ) {
        this.pendingRestore = options.restore;
    }

    /**
     * The Drive event the restored listings are true up to, once the root has
     * loaded and the snapshot applied; `undefined` when nothing was restored.
     */
    get restoredEventId(): string | undefined {
        return this.restoredFrom;
    }

    /** How many listings loaded from Drive so far; a restored one does not count. */
    get listingsLoaded(): number {
        return this.loads;
    }

    /**
     * The listings that finished loading, keyed to My files' root and its
     * event scope; `undefined` before the root has loaded.
     */
    snapshot(): Omit<ListingSnapshot, 'lastEventId'> | undefined {
        if (!this.myFilesRoot) {
            return undefined;
        }
        const listings = new Map<string, Entry[]>();
        for (const [folderUid, pending] of this.listings) {
            const listing = this.loaded.get(pending);
            if (listing) {
                listings.set(folderUid, [...listing.values()]);
            }
        }
        return { rootUid: this.myFilesRoot.uid, eventScopeId: this.myFilesRoot.treeEventScopeId, listings };
    }

    /** The served root: My files, or the `--root` folder inside it. */
    root(): Promise<Entry> {
        this.rootEntry ??= this.loadRoot().catch((error: unknown) => {
            this.rootEntry = undefined;
            // The lookup may have cached listings on its way down; drop them so
            // the next ask, after e.g. the root folder appears, sees Drive anew.
            this.listings.clear();
            throw error;
        });
        return this.rootEntry;
    }

    /** Resolves path segments below the root. Returns `undefined` when a segment does not exist. */
    async stat(segments: string[]): Promise<Entry | undefined> {
        let entry = await this.root();
        for (const segment of segments) {
            if (entry.kind !== 'folder') {
                return undefined;
            }
            const child: Entry | undefined = (await this.listing(entry.uid)).get(segment);
            if (!child) {
                return undefined;
            }
            entry = child;
        }
        return entry;
    }

    async list(folder: Entry): Promise<Entry[]> {
        return [...(await this.listing(folder.uid)).values()];
    }

    /**
     * Moves a file or folder to Drive's trash, so its content stays
     * recoverable in the Drive UI. The parent's cached listing is dropped at
     * once, so the next ask no longer shows the trashed name.
     */
    async trash(segments: string[]): Promise<void> {
        if (segments.length === 0) {
            throw new DriveError(403, 'The root folder cannot be deleted');
        }
        const entry = await this.stat(segments);
        if (!entry) {
            throw new DriveError(404, `/${segments.join('/')} not found`);
        }
        await this.backoff.run(async () => {
            for await (const result of this.sdk.trashNodes([entry.uid])) {
                if (!result.ok) {
                    throw result.error;
                }
            }
        });
        this.forget(entry);
    }

    /**
     * Moves and/or renames an entry. With `overwrite`, an existing target goes
     * to trash first. The entry keeps its UID and revisions.
     */
    async move(
        fromSegments: string[],
        toSegments: string[],
        overwrite: boolean,
    ): Promise<{ entry: Entry; created: boolean }> {
        if (fromSegments.length === 0 || toSegments.length === 0) {
            throw new DriveError(403, 'The root folder cannot be moved');
        }
        const fromEntry = await this.stat(fromSegments);
        if (!fromEntry) {
            throw new DriveError(404, `/${fromSegments.join('/')} not found`);
        }
        const toParent = toSegments.slice(0, -1);
        const newName = toSegments[toSegments.length - 1];

        if (this.isPrefix(fromSegments, toSegments)) {
            throw new DriveError(409, 'Cannot move a folder into itself');
        }
        if (this.isPrefix(toSegments, fromSegments)) {
            throw new DriveError(409, 'Cannot move an entry onto a folder that contains it');
        }

        const targetParent = await this.stat(toParent);
        if (!targetParent || targetParent.kind !== 'folder') {
            throw new DriveError(409, `/${toParent.join('/')} is not a folder`);
        }

        const targetListing = await this.listing(targetParent.uid);
        const target = targetListing.get(newName);
        if (target?.uid === fromEntry.uid) {
            return { entry: fromEntry, created: false };
        }

        if (target) {
            if (!overwrite) {
                throw new DriveError(412, `${newName} already exists`);
            }
            await this.trash(toSegments);
        }

        const fromParent = fromSegments.slice(0, -1);
        const fromParentEntry = fromSegments.length >= 1 ? await this.stat(fromParent) : undefined;
        const fromParentUid = fromParentEntry?.uid;

        try {
            if (fromParentUid !== targetParent.uid) {
                await this.backoff.run(async () => {
                    for await (const result of this.sdk.moveNodes([fromEntry.uid], targetParent.uid)) {
                        if (!result.ok) {
                            throw result.error;
                        }
                    }
                });
            }
            if (fromEntry.name !== newName) {
                await this.backoff.run(() => this.sdk.renameNode(fromEntry.uid, newName));
            }
        } finally {
            this.forget(fromEntry);
            if (fromParentUid) {
                this.listings.delete(fromParentUid);
            }
            this.listings.delete(targetParent.uid);
        }

        const node = await this.sdk.getNode(fromEntry.uid);
        const entry = toEntry(node as NodeEntity) as Entry;
        return { entry, created: !target };
    }

    /** Checks if `segments` is a proper prefix of `potentialChild`. */
    private isPrefix(segments: string[], potentialChild: string[]): boolean {
        return segments.length < potentialChild.length && segments.every((s, i) => s === potentialChild[i]);
    }

    /**
     * Creates a folder under `parentSegments`. An existing name of any kind is
     * a 405; the parent's cached listing is dropped, so the next ask shows
     * the new folder.
     */
    async createFolder(parentSegments: string[], name: string): Promise<Entry> {
        const parent = await this.stat(parentSegments);
        if (!parent || parent.kind !== 'folder') {
            throw new DriveError(409, `/${parentSegments.join('/')} is not a folder`);
        }
        const existing = (await this.listing(parent.uid)).get(name);
        if (existing) {
            throw new DriveError(405, `${name} already exists`);
        }
        const node = await this.backoff.run(() => this.sdk.createFolder(parent.uid, name));
        this.listings.delete(parent.uid);
        return toEntry(node as NodeEntity) as Entry;
    }

    /** Streams a file. `signal` is the client's request; when it aborts, the download stops. */
    async read(file: Entry, range?: ByteRange, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
        if (file.kind !== 'file') {
            throw new DriveError(405, `${file.name} is a folder`);
        }
        return this.backoff.run(() =>
            openDownload(this.sdk, file, {
                range,
                signal,
                logger: this.logger,
            }),
        );
    }

    /**
     * Uploads a file. A new name creates a file; an existing file gets a new
     * revision, so Proton keeps the old content in the file's history. `size`
     * drives the SDK's exact size check; pass it whenever the client declared
     * `Content-Length`.
     */
    async upload(
        parentSegments: string[],
        name: string,
        body: ReadableStream<Uint8Array>,
        options: UploadOptions,
        signal?: AbortSignal,
    ): Promise<{ entry: Entry; created: boolean }> {
        const parent = await this.stat(parentSegments);
        if (!parent || parent.kind !== 'folder') {
            throw new DriveError(409, `/${parentSegments.join('/')} is not a folder`);
        }
        const existing = (await this.listing(parent.uid)).get(name);
        if (existing?.kind === 'folder') {
            throw new DriveError(405, `${name} is a folder`);
        }
        const metadata = {
            mediaType: options.mediaType,
            expectedSize: options.size ?? null,
            ...(options.modified ? { modificationTime: options.modified } : {}),
        };
        const node = await this.backoff.run(async () => {
            const uploader = existing
                ? await this.sdk.getFileRevisionUploader(existing.uid, metadata, signal)
                : await this.sdk.getFileUploader(parent.uid, name, metadata, signal);
            const controller = await uploader.uploadFromStream(body, []);
            const result = await controller.completion();
            return await this.sdk.getNode(result.nodeUid);
        });
        const entry = toEntry(node as NodeEntity) as Entry;
        // A loaded listing takes the new entry in place, so a run of uploads into one
        // folder does not list it again after each. A listing still loading may have
        // read the folder before the file was there; drop it so the next ask loads anew.
        const pending = this.listings.get(parent.uid);
        const listing = pending && this.loaded.get(pending);
        if (listing) {
            listing.set(entry.name, entry);
        } else {
            this.listings.delete(parent.uid);
        }
        return { entry, created: !existing };
    }

    /** The folder's cached listing, loading it from the SDK on the first ask. */
    private listing(folderUid: string): Promise<Listing> {
        const cached = this.listings.get(folderUid);
        if (cached) {
            return cached;
        }
        const pending = this.loadListing(folderUid);
        this.listings.set(folderUid, pending);
        pending.then(
            (listing) => {
                this.loaded.set(pending, listing);
                this.loads++;
            },
            () => {
                if (this.listings.get(folderUid) === pending) {
                    this.listings.delete(folderUid);
                }
            },
        );
        return pending;
    }

    /** Drops the cached listings of these folders, so the next ask loads them anew. */
    dropListings(folderUids: Iterable<string | undefined>): void {
        for (const uid of folderUids) {
            if (uid !== undefined) {
                this.listings.delete(uid);
            }
        }
    }

    /**
     * Drops every loaded listing that holds this node. A move's event names only the new
     * parent, so this is how the old parent's listing learns the node left.
     */
    dropListingsHolding(nodeUid: string): void {
        for (const [folderUid, pending] of this.listings) {
            const listing = this.loaded.get(pending);
            if (listing && [...listing.values()].some((entry) => entry.uid === nodeUid)) {
                this.listings.delete(folderUid);
            }
        }
    }

    /** Drops every cached listing. */
    clear(): void {
        this.listings.clear();
    }

    /** Forgets the cached views a trashed entry takes part in: its own folder, and its parent's. */
    private forget(entry: Entry): void {
        if (entry.parentUid) {
            this.listings.delete(entry.parentUid);
        }
        this.listings.delete(entry.uid);
    }

    private loadListing(folderUid: string): Promise<Listing> {
        return this.backoff.run(async () => {
            const uids: string[] = [];
            for await (const uid of this.sdk.iterateFolderChildrenNodeUids(folderUid)) {
                uids.push(uid);
            }
            const listing: Listing = new Map();
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
            }
            return listing;
        });
    }

    private loadRoot(): Promise<Entry> {
        return this.backoff.run(async () => {
            let entry = toEntry(await this.sdk.getMyFilesRootFolder());
            if (isSkipped(entry)) {
                throw new Error(`Cannot serve the root of My files: ${entry.skipped}`);
            }
            this.myFilesRoot = entry;
            this.applyRestore(entry);
            const rootPath = this.options.rootPath ?? [];
            for (const segment of rootPath) {
                if (entry.kind !== 'folder') {
                    throw missingRoot(rootPath);
                }
                // A restored listing may predate a rename or trash of the root folder, and the
                // event replay comes too late to undo a root resolved through it: list from Drive.
                this.listings.delete(entry.uid);
                const child: Entry | undefined = (await this.listing(entry.uid)).get(segment);
                if (!child || child.kind !== 'folder') {
                    throw missingRoot(rootPath);
                }
                entry = child;
            }
            return entry;
        });
    }

    /** Installs the saved listings, once, if they were taken of this My files root and scope. */
    private applyRestore(myFilesRoot: Entry): void {
        const saved = this.pendingRestore;
        this.pendingRestore = undefined;
        if (!saved) {
            return;
        }
        if (saved.rootUid !== myFilesRoot.uid || saved.eventScopeId !== myFilesRoot.treeEventScopeId) {
            this.logger.info('Ignoring the saved listings: they belong to another My files');
            return;
        }
        for (const [folderUid, entries] of saved.listings) {
            const listing: Listing = new Map(entries.map((entry) => [entry.name, entry]));
            const pending = Promise.resolve(listing);
            this.loaded.set(pending, listing);
            this.listings.set(folderUid, pending);
        }
        this.restoredFrom = saved.lastEventId;
    }
}

/** The error for a configured root folder My files does not hold. */
function missingRoot(rootPath: string[]): DriveError {
    return new DriveError(500, `Root folder /${rootPath.join('/')} does not exist in My files`);
}

