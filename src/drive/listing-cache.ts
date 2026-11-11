import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { Entry } from './entry';

export const LISTING_CACHE_FILE_NAME = 'listing-cache.json';
const FORMAT_VERSION = 1;

/** The tree's loaded listings, and the Drive event they are true up to. */
export type ListingSnapshot = {
    /** UID of My files' root folder: a snapshot of another account or volume does not apply. */
    rootUid: string;
    /** The event scope the watcher reads, which `lastEventId` belongs to. */
    eventScopeId: string;
    lastEventId: string;
    /** Each loaded folder's children, by folder UID. */
    listings: Map<string, Entry[]>;
};

type StoredEntry = Omit<Entry, 'modified' | 'created'> & { modified: string; created: string };

type StoredSnapshot = {
    version: typeof FORMAT_VERSION;
    savedAt: string;
    rootUid: string;
    eventScopeId: string;
    lastEventId: string;
    listings: Record<string, StoredEntry[]>;
};

/**
 * Keeps the tree's listings across restarts in one JSON file in the state dir.
 *
 * The file holds the clear-text names of the cached folders' children, so it
 * gets mode 0600 in a 0700 dir, as the session does. A file this version
 * cannot read is ignored: the serve then lists from Drive, as on a first start.
 */
export class ListingCacheFile {
    readonly filePath: string;

    constructor(readonly stateDir: string) {
        this.filePath = path.join(stateDir, LISTING_CACHE_FILE_NAME);
    }

    /** The saved snapshot, or `undefined` when there is none or it is not in this version's format. */
    async read(): Promise<ListingSnapshot | undefined> {
        let stored: Partial<StoredSnapshot>;
        try {
            stored = JSON.parse(await Bun.file(this.filePath).text()) as Partial<StoredSnapshot>;
        } catch {
            return undefined;
        }
        if (
            stored?.version !== FORMAT_VERSION ||
            typeof stored.rootUid !== 'string' ||
            typeof stored.eventScopeId !== 'string' ||
            typeof stored.lastEventId !== 'string' ||
            typeof stored.listings !== 'object' ||
            stored.listings === null
        ) {
            return undefined;
        }
        const listings = new Map<string, Entry[]>();
        for (const [folderUid, storedEntries] of Object.entries(stored.listings)) {
            if (!Array.isArray(storedEntries)) {
                return undefined;
            }
            const entries: Entry[] = [];
            for (const storedEntry of storedEntries as unknown[]) {
                const entry = toEntry(storedEntry);
                if (!entry) {
                    return undefined;
                }
                entries.push(entry);
            }
            listings.set(folderUid, entries);
        }
        return { rootUid: stored.rootUid, eventScopeId: stored.eventScopeId, lastEventId: stored.lastEventId, listings };
    }

    /** Replaces the file whole, so a crash mid-write leaves the old snapshot or the new one, never half. */
    async write(snapshot: ListingSnapshot): Promise<void> {
        const stored: StoredSnapshot = {
            version: FORMAT_VERSION,
            savedAt: new Date().toISOString(),
            rootUid: snapshot.rootUid,
            eventScopeId: snapshot.eventScopeId,
            lastEventId: snapshot.lastEventId,
            listings: Object.fromEntries(
                [...snapshot.listings].map(([folderUid, entries]) => [
                    folderUid,
                    entries.map((entry) => ({ ...entry, modified: entry.modified.toISOString(), created: entry.created.toISOString() })),
                ]),
            ),
        };
        await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
        await chmod(this.stateDir, 0o700);
        const tmpPath = `${this.filePath}.${process.pid}.tmp`;
        try {
            await Bun.write(tmpPath, JSON.stringify(stored), { mode: 0o600 });
            await chmod(tmpPath, 0o600);
            await rename(tmpPath, this.filePath);
        } catch (error) {
            // The temporary file holds the clear-text names too; do not leave it behind.
            await rm(tmpPath, { force: true }).catch(() => {});
            throw error;
        }
    }

    /** Deletes the file, and any temporary file a save that died midway left. */
    async remove(): Promise<void> {
        await rm(this.filePath, { force: true });
        let names: string[];
        try {
            names = await readdir(this.stateDir);
        } catch {
            return;
        }
        const leftover = (name: string) => name.startsWith(`${LISTING_CACHE_FILE_NAME}.`) && name.endsWith('.tmp');
        for (const name of names.filter(leftover)) {
            await rm(path.join(this.stateDir, name), { force: true });
        }
    }
}

/** A stored entry as an Entry, or `undefined` when any field is missing or of the wrong type. */
function toEntry(stored: unknown): Entry | undefined {
    if (typeof stored !== 'object' || stored === null) {
        return undefined;
    }
    const entry = stored as Record<string, unknown>;
    const modified = toDate(entry.modified);
    const created = toDate(entry.created);
    if (
        typeof entry.uid !== 'string' ||
        typeof entry.name !== 'string' ||
        (entry.kind !== 'file' && entry.kind !== 'folder') ||
        typeof entry.size !== 'number' ||
        !modified ||
        !created ||
        typeof entry.treeEventScopeId !== 'string' ||
        !['mediaType', 'sha1', 'revisionUid', 'parentUid', 'armoredNodeKey'].every(
            (field) => entry[field] === undefined || typeof entry[field] === 'string',
        )
    ) {
        return undefined;
    }
    return { ...(entry as Omit<Entry, 'modified' | 'created'>), modified, created };
}

function toDate(value: unknown): Date | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}
