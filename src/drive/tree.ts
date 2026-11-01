import type { NodeEntity } from '@protontech/drive-sdk';

import type { Logger } from '../../vendor/proton-drive-sdk-account';

import { type Entry, isSkipped, toEntry } from './entry';
import type { DriveSdk } from './sdk';

/** One folder's children, by name. */
type Listing = Map<string, Entry>;

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
