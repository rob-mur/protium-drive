import type { NodeEntity } from '@protontech/drive-sdk';

import type { Logger } from '../../vendor/proton-drive-sdk-account';

import { openDownload, type ByteRange } from './download';
import { type Entry, isSkipped, toEntry } from './entry';
import { DriveError } from './errors';
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

/**
 * Proton Drive as a tree of paths, on top of the SDK's node UIDs.
 *
 * A folder's listing loads only when a client asks for it and stays cached by
 * folder UID, so repeated stats and listings cost no Drive calls and nothing
 * walks the tree in the background. A failed listing is not cached, so the
 * next ask loads the folder again.
 */
export class DriveTree {
    private rootEntry?: Promise<Entry>;
    private readonly listings = new Map<string, Promise<Listing>>();

    constructor(
        private readonly sdk: DriveSdk,
        private readonly logger: Logger,
    ) {}

    /** The served root: My files. */
    root(): Promise<Entry> {
        this.rootEntry ??= this.loadRoot().catch((error: unknown) => {
            this.rootEntry = undefined;
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
        for await (const result of this.sdk.trashNodes([entry.uid])) {
            if (!result.ok) {
                throw result.error;
            }
        }
        this.forget(entry);
    }

    /** Streams a file. `signal` is the client's request; when it aborts, the download stops. */
    async read(file: Entry, range?: ByteRange, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
        if (file.kind !== 'file') {
            throw new DriveError(405, `${file.name} is a folder`);
        }
        return openDownload(this.sdk, file, {
            range,
            signal,
            logger: this.logger,
        });
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
        const uploader = existing
            ? await this.sdk.getFileRevisionUploader(existing.uid, metadata, signal)
            : await this.sdk.getFileUploader(parent.uid, name, metadata, signal);
        const controller = await uploader.uploadFromStream(body, []);
        const result = await controller.completion();
        const node = await this.sdk.getNode(result.nodeUid);
        // The listing holds the old entry (or none); drop it so the next ask reloads the folder.
        this.listings.delete(parent.uid);
        return { entry: toEntry(node as NodeEntity) as Entry, created: !existing };
    }

    /** The folder's cached listing, loading it from the SDK on the first ask. */
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

    /** Forgets the cached views a trashed entry takes part in: its own folder, and its parent's. */
    private forget(entry: Entry): void {
        if (entry.parentUid) {
            this.listings.delete(entry.parentUid);
        }
        this.listings.delete(entry.uid);
    }

    private async loadListing(folderUid: string): Promise<Listing> {
        const uids: string[] = [];
        for await (const uid of this.sdk.iterateFolderChildrenNodeUids(folderUid)) {
            uids.push(uid);
        }
        const listing: Listing = new Map();
        for await (const node of this.sdk.iterateNodes(uids)) {
            const entry = toEntry(node as NodeEntity);
            if (isSkipped(entry)) {
                this.logger.debug(`Not serving a node of ${folderUid}: ${entry.skipped}`);
                continue;
            }
            listing.set(entry.name, entry);
        }
        return listing;
    }

    private async loadRoot(): Promise<Entry> {
        const entry = toEntry(await this.sdk.getMyFilesRootFolder());
        if (isSkipped(entry)) {
            throw new Error(`Cannot serve the root of My files: ${entry.skipped}`);
        }
        return entry;
    }
}
