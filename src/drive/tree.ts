import type { NodeEntity } from '@protontech/drive-sdk';

import type { Logger } from '../../vendor/proton-drive-sdk-account';

import { type Entry, isSkipped, toEntry } from './entry';
import type { DriveSdk } from './sdk';

/**
 * Proton Drive as a tree of paths, on top of the SDK's node UIDs.
 *
 * The walking skeleton resolves every path by walking the children of the
 * root, one SDK listing per segment, and caches nothing between requests;
 * the listing work (its cache and its call counts) is the next ticket's.
 */
export class DriveTree {
    private rootEntry?: Promise<Entry>;

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
            const child: Entry | undefined = (await this.list(entry)).find((item) => item.name === segment);
            if (!child) {
                return undefined;
            }
            entry = child;
        }
        return entry;
    }

    async list(folder: Entry): Promise<Entry[]> {
        const uids: string[] = [];
        for await (const uid of this.sdk.iterateFolderChildrenNodeUids(folder.uid)) {
            uids.push(uid);
        }
        const entries: Entry[] = [];
        for await (const node of this.sdk.iterateNodes(uids)) {
            const entry = toEntry(node as NodeEntity);
            if (isSkipped(entry)) {
                this.logger.debug(`Not serving a node of ${folder.name}: ${entry.skipped}`);
                continue;
            }
            entries.push(entry);
        }
        return entries;
    }

    private async loadRoot(): Promise<Entry> {
        const entry = toEntry(await this.sdk.getMyFilesRootFolder());
        if (isSkipped(entry)) {
            throw new Error(`Cannot serve the root of My files: ${entry.skipped}`);
        }
        return entry;
    }
}
