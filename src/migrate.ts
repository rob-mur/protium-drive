import { createHash } from 'node:crypto';

import { type NodeEntity, RateLimitedError } from '@protontech/drive-sdk';

import type { Logger } from '../vendor/proton-drive-sdk-account';

import { Backoff } from './drive/backoff';
import { openDownload } from './drive/download';
import { type Entry, isSkipped, toEntry } from './drive/entry';
import { DriveError } from './drive/errors';
import { describeNodeKey, needsMigration } from './drive/node-key';
import type { DriveSdk } from './drive/sdk';
import { DriveTree } from './drive/tree';
import { connect } from './proton/connect';
import { NOT_SIGNED_IN, REFUSED_SESSION } from './serve';
import { acquireStateLock } from './session/lock';
import { parsePath } from './webdav/paths';

/** The name a file carries while its v4 copy is being made; the copy takes the real name last. */
export const TEMPORARY_SUFFIX = '.pdm-migrating';

/** How often one step waits out Proton's rate limit before the file counts as failed. */
const MAX_PAUSES = 10;

export type Migration = {
    /** Files re-uploaded under a v4 node key. */
    migrated: number;
    /** Files a stopped run had copied, and this run finished. */
    finished: number;
    /** Files that already hold a v4 key. */
    alreadyV4: number;
    /** Files `--dry-run` would migrate or finish. */
    wouldMigrate: number;
    failed: number;
};

export type MigrateOptions = {
    sdk: DriveSdk;
    tree: DriveTree;
    logger: Logger;
    /** The folder to walk, as path segments below My files. */
    folder: string[];
    dryRun: boolean;
    /** Receives one line per file that changes, would change or fails. */
    report: (line: string) => void;
    /** Waits out a rate limit; tests pass one that does not wait. */
    sleep?: (ms: number) => Promise<void>;
};

/** What a stream held: its SHA1 (hex) and its length. */
type Fingerprint = { sha1: string; size: number };

/**
 * Gives every file below `folder` whose node key is v6 or locked with Argon2 a
 * v4 node key, which the SDK writes. Rclone 1.75.0 wrote the others, and the
 * SDK cannot open them.
 *
 * A file is copied, never edited in place. Per file, in this order:
 *  1. download the active revision and check its stored SHA1,
 *  2. upload it under a temporary name in the same folder,
 *  3. download the copy and compare it with the original,
 *  4. move the original to the trash,
 *  5. rename the copy to the original's name.
 * Each step leaves a state the next run reads and finishes, so a run that
 * stops anywhere does no harm and a second run does the rest. Nothing is ever
 * deleted for good: the original stays in the Drive's trash.
 */
export async function migrateNodeKeys(options: MigrateOptions): Promise<Migration> {
    const root = await options.tree.stat(options.folder);
    const path = `/${options.folder.join('/')}`;
    if (!root) {
        throw new DriveError(404, `${path} not found`);
    }
    if (root.kind !== 'folder') {
        throw new DriveError(409, `${path} is not a folder`);
    }
    const run = new Run(options);
    await run.walk(root, options.folder);
    return run.migration;
}

export type MigrateCommandOptions = {
    stateDir: string;
    /** The folder of My files to walk, as the user typed it. */
    folder: string;
    dryRun: boolean;
    logger: Logger;
    /** The fake drive's directory (`--fake-drive`): the Drive then comes from the Receive arm. */
    fakeDriveDir?: string;
    print: (line: string) => void;
    error: (line: string) => void;
};

/**
 * `migrate-node-keys FOLDER [--dry-run]`: signs in from the saved session,
 * migrates the folder and says what became of each file. Exits 0 when no file
 * failed, and 1 when one did or the folder cannot be walked.
 *
 * It takes the state lock like the serve does, because two processes that share
 * the session refresh its token against each other. The fake drive has no
 * token to rotate, and the scenarios migrate while a serve shares its Drive, so
 * `--fake-drive` skips the lock.
 */
export async function migrateNodeKeysCommand(options: MigrateCommandOptions): Promise<number> {
    const { stateDir, logger } = options;
    const release = options.fakeDriveDir === undefined ? await acquireStateLock(stateDir) : undefined;
    try {
        const connection = await connect({ stateDir, logger, fakeDriveDir: options.fakeDriveDir });
        try {
            await connection.auth.loadSession();
            if (!connection.auth.isLoggedIn()) {
                // A session Proton refused stays on disk, marked; it is no session to use.
                const rejectedAt = connection.credentials.rejectedAt;
                options.error(rejectedAt ? REFUSED_SESSION(rejectedAt) : NOT_SIGNED_IN);
                return 1;
            }
            const sdk = await connection.createDriveClient();
            const clock = connection.clock;
            const tree = new DriveTree(sdk, logger, new Backoff(clock?.now.bind(clock)));
            const migration = await migrateNodeKeys({
                sdk,
                tree,
                logger,
                folder: parsePath(options.folder),
                dryRun: options.dryRun,
                report: options.print,
                sleep: (ms) => new Promise<void>((resolve) => (clock ? clock.setTimeout(resolve, ms) : setTimeout(resolve, ms))),
            });
            options.print(summarize(migration, options.dryRun));
            return migration.failed === 0 ? 0 : 1;
        } catch (error: unknown) {
            options.error(error instanceof Error ? error.message : String(error));
            return 1;
        } finally {
            await connection.stop();
        }
    } finally {
        await release?.();
    }
}

function summarize(migration: Migration, dryRun: boolean): string {
    const parts = dryRun
        ? [`${migration.wouldMigrate} to migrate`]
        : [`${migration.migrated} migrated`, `${migration.finished} finished from an earlier run`];
    parts.push(`${migration.alreadyV4} already v4`, `${migration.failed} failed`);
    return `${dryRun ? 'Dry run: ' : ''}${parts.join(', ')}.`;
}

class Run {
    readonly migration: Migration = { migrated: 0, finished: 0, alreadyV4: 0, wouldMigrate: 0, failed: 0 };

    constructor(private readonly options: MigrateOptions) {}

    async walk(folder: Entry, segments: string[]): Promise<void> {
        const children = await this.paced(() => this.options.tree.list(folder));
        const names = new Map(children.map((child) => [child.name, child]));
        const copies = new Map<string, Entry>();
        for (const child of children) {
            const original = originalName(child.name);
            if (child.kind === 'file' && original !== undefined) {
                copies.set(original, child);
            }
        }
        for (const child of children) {
            const display = [...segments, child.name].join('/');
            if (child.kind === 'folder') {
                await this.walk(child, [...segments, child.name]);
            } else if (originalName(child.name) !== undefined) {
                const original = names.get(originalName(child.name)!);
                // A copy whose original is still there is dealt with together with it.
                if (!original || original.kind !== 'file') {
                    await this.each(display, () => this.lone(child, [...segments, originalName(child.name)!].join('/')));
                }
            } else {
                await this.each(display, () => this.file(child, copies.get(child.name), display));
            }
        }
    }

    /** Runs one file's work; a failure is reported and counted, and the run goes on. */
    private async each(display: string, work: () => Promise<void>): Promise<void> {
        try {
            await work();
        } catch (error: unknown) {
            this.migration.failed += 1;
            const message = error instanceof Error ? error.message : String(error);
            this.options.logger.debug(`Migrating ${display} failed: ${String(error)}`);
            this.options.report(`failed ${display}: ${message}`);
        }
    }

    /** A file under the temporary name whose original is gone: the old node was trashed, only the rename is left. */
    private async lone(copy: Entry, display: string): Promise<void> {
        if (!this.isV4(copy)) {
            return this.leaveAlone(`${display}${TEMPORARY_SUFFIX}`, `it holds a version ${this.describe(copy).version} node key`);
        }
        if (this.options.dryRun) {
            return this.wouldFinish(display);
        }
        await this.finish(copy, undefined, originalName(copy.name)!, display);
    }

    private wouldFinish(display: string): void {
        this.migration.wouldMigrate += 1;
        this.options.report(`would finish ${display}`);
    }

    private async file(original: Entry, copy: Entry | undefined, display: string): Promise<void> {
        const key = this.describe(original);
        if (!needsMigration(key)) {
            this.migration.alreadyV4 += 1;
            if (copy) {
                this.leaveAlone(`${display}${TEMPORARY_SUFFIX}`, `the file ${original.name} already has a v4 node key`);
            }
            return;
        }
        const { dryRun, report } = this.options;
        if (copy && this.isV4(copy) && (await this.sameContent(original, copy))) {
            if (dryRun) {
                return this.wouldFinish(display);
            }
            return this.finish(copy, original, original.name, display);
        }
        if (dryRun) {
            this.migration.wouldMigrate += 1;
            return report(`would migrate ${display}`);
        }
        if (copy) {
            if (!this.isV4(copy)) {
                throw new Error(`${copy.name} is in the way and holds a version ${this.describe(copy).version} node key, which is not ours`);
            }
            // A copy that is not whole: it goes to the trash and the file starts over.
            await this.trash(copy);
        }
        await this.migrate(original, display);
    }

    /** Whether the content of both files is the same; false when the copy was not whole. */
    private async sameContent(original: Entry, copy: Entry): Promise<boolean> {
        if (this.options.dryRun) {
            return this.isV4(copy);
        }
        const [a, b] = [await this.fingerprint(original), await this.fingerprint(copy)];
        return a.sha1 === b.sha1 && a.size === b.size;
    }

    private async migrate(original: Entry, display: string): Promise<void> {
        const { sdk } = this.options;
        const temporary = `${original.name}${TEMPORARY_SUFFIX}`;
        let sent: Fingerprint | undefined;
        const created = await this.paced(async () => {
            const source = await openDownload(sdk, original, { logger: this.options.logger });
            const [stream, measured] = measure(source);
            const uploader = await sdk.getFileUploader(original.parentUid!, temporary, {
                mediaType: original.mediaType ?? 'application/octet-stream',
                expectedSize: original.size,
                ...(original.modified ? { modificationTime: original.modified } : {}),
                ...(original.sha1 ? { expectedSha1: original.sha1 } : {}),
            });
            const controller = await uploader.uploadFromStream(stream, []);
            const result = await controller.completion();
            sent = measured();
            return result.nodeUid;
        });
        const copy = this.entryOf(await this.paced(() => sdk.getNode(created)));
        try {
            const read = sent!;
            if (original.sha1 && original.sha1 !== read.sha1) {
                throw new Error(`the download's SHA1 ${read.sha1} is not the stored ${original.sha1}`);
            }
            if (read.size !== original.size) {
                throw new Error(`the download holds ${read.size} bytes, not ${original.size}`);
            }
            if (!this.isV4(copy)) {
                throw new Error("the new node's key is not a v4 key");
            }
            const check = await this.fingerprint(copy);
            if (check.sha1 !== read.sha1 || check.size !== read.size) {
                throw new Error('the content of the new node differs from the original');
            }
        } catch (error: unknown) {
            await this.trash(copy).catch(() => {});
            throw error;
        }
        await this.finish(copy, original, original.name, display, 'migrated');
    }

    /** Trashes the original, if there is one, and gives the copy the original's name. */
    private async finish(copy: Entry, original: Entry | undefined, name: string, display: string, done: 'migrated' | 'finished' = 'finished'): Promise<void> {
        if (original) {
            await this.trash(original);
        }
        await this.paced(() => this.options.sdk.renameNode(copy.uid, name));
        this.migration[done] += 1;
        this.options.report(`${done} ${display}`);
    }

    private async trash(entry: Entry): Promise<void> {
        await this.paced(async () => {
            for await (const result of this.options.sdk.trashNodes([entry.uid])) {
                if (!result.ok) {
                    throw result.error;
                }
            }
        });
    }

    /** The SHA1 and length of what `entry` downloads as. */
    private async fingerprint(entry: Entry): Promise<Fingerprint> {
        return this.paced(async () => {
            const [stream, measured] = measure(await openDownload(this.options.sdk, entry, { logger: this.options.logger }));
            await stream.pipeTo(new WritableStream());
            return measured();
        });
    }

    private leaveAlone(display: string, reason: string): void {
        this.options.report(`left alone ${display}: ${reason}`);
    }

    private describe(entry: Entry) {
        if (!entry.armoredNodeKey) {
            throw new Error('the SDK shows no node key for it');
        }
        return describeNodeKey(entry.armoredNodeKey);
    }

    private isV4(entry: Entry): boolean {
        return !needsMigration(this.describe(entry));
    }

    private entryOf(node: unknown): Entry {
        const entry = toEntry(node as NodeEntity);
        if (isSkipped(entry)) {
            throw new Error(`the new node cannot be read: ${entry.skipped}`);
        }
        return entry;
    }

    /**
     * Runs one step. When Proton rate-limits it, waits out the pause Proton
     * asks for and runs it again, up to `MAX_PAUSES` times.
     */
    private async paced<T>(step: () => Promise<T>): Promise<T> {
        const { tree, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = this.options;
        for (let pauses = 1; ; pauses++) {
            try {
                return await tree.backoff.run(step);
            } catch (error: unknown) {
                const seconds =
                    error instanceof DriveError && error.status === 503
                        ? error.retryAfterSeconds
                        : error instanceof RateLimitedError
                          ? tree.backoff.coolingDownSeconds
                          : undefined;
                if (seconds === undefined || pauses >= MAX_PAUSES) {
                    throw error;
                }
                this.options.logger.warn(`Proton rate limit: waiting ${seconds}s`);
                await sleep(seconds * 1000);
            }
        }
    }
}

/** `a.jpg` for `a.jpg.pdm-migrating`; `undefined` for any other name. */
function originalName(name: string): string | undefined {
    return name.length > TEMPORARY_SUFFIX.length && name.endsWith(TEMPORARY_SUFFIX) ? name.slice(0, -TEMPORARY_SUFFIX.length) : undefined;
}

/**
 * Passes a stream on while it counts its bytes and hashes them. The second
 * value gives the SHA1 and length of what has passed so far.
 */
function measure(source: ReadableStream<Uint8Array>): [ReadableStream<Uint8Array>, () => Fingerprint] {
    const hash = createHash('sha1');
    let size = 0;
    const stream = source.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                hash.update(chunk);
                size += chunk.byteLength;
                controller.enqueue(chunk);
            },
        }),
    );
    return [stream, () => ({ sha1: hash.copy().digest('hex'), size })];
}
