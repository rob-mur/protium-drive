import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RateLimitedError } from '@protontech/drive-sdk';

import { FakeDrive, FakeDriveClient, type SdkSurface } from '../fake-drive/drive.ts';
import { armoredNodeKey } from '../fake-drive/node-keys.ts';
import { Backoff } from './drive/backoff.ts';
import { DriveTree } from './drive/tree.ts';
import { createLogger } from './logger.ts';
import { migrateNodeKeys, TEMPORARY_SUFFIX, type MigrateOptions, type Migration } from './migrate.ts';

const CLAIMED = '2026-08-14T09:30:00.000Z';
const QUIET = createLogger('error');
const text = (value: string) => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

let dir: string;
let drive: FakeDrive;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdm-migrate-'));
    drive = FakeDrive.open(dir);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Adds a file as another client would, claiming `CLAIMED` as its modification time, as the spec's seed does. */
function addFile(path: string, content: string, nodeKey: 'v4' | 'argon2', mediaType = 'image/jpeg'): string {
    const uid = drive.add(path, { type: 'file', content: text(content), nodeKey, mediaType });
    const file = join(dir, 'drive.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.nodes[uid].claimedModificationTime = CLAIMED;
    state.nodes[uid].revisions[0].claimedModificationTime = CLAIMED;
    writeFileSync(file, JSON.stringify(state));
    return uid;
}

type Run = { migration: Migration; lines: string[]; sleeps: number[] };

/** Runs the migration of `folder` over the fake Drive; `wrap` lets a test change what the SDK does. */
async function run(folder: string, options: Partial<MigrateOptions> = {}, wrap: (sdk: SdkSurface) => SdkSurface = (sdk) => sdk): Promise<Run> {
    const sdk = wrap(new FakeDriveClient(drive));
    const lines: string[] = [];
    const sleeps: number[] = [];
    const tree = new DriveTree(sdk, QUIET, new Backoff());
    const migration = await migrateNodeKeys({
        sdk,
        tree,
        logger: QUIET,
        folder: folder.split('/').filter(Boolean),
        dryRun: false,
        report: (line) => lines.push(line),
        sleep: async (ms) => {
            sleeps.push(ms);
        },
        ...options,
    });
    return { migration, lines, sleeps };
}

/** The SDK, with `method` replaced by what `replace` makes of the original. */
// biome-ignore lint/suspicious/noExplicitAny: a test double changes one method whatever its signature.
function replacing(method: keyof SdkSurface, replace: (original: any) => any) {
    return (sdk: SdkSurface): SdkSurface =>
        new Proxy(sdk, {
            get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property === method) return replace((value as Function).bind(target));
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
}

const trashedNames = () => drive.trashed().map((node) => node.name);

describe('migrating a file with an Argon2-locked node key', () => {
    test('re-uploads it with a v4 key, keeps content, media type and modification time, and trashes the old node', async () => {
        const oldUid = addFile('Photos/beach.jpg', 'sand and sea', 'argon2');

        const { migration, lines } = await run('Photos');

        const node = drive.nodeAt('Photos/beach.jpg');
        expect(node.nodeKeyVersion).toBe(4);
        expect(node.uid).not.toBe(oldUid);
        expect(node.mediaType).toBe('image/jpeg');
        expect(drive.revisions('Photos/beach.jpg').map((revision) => revision.claimedModificationTime)).toEqual([CLAIMED]);
        expect(decode(drive.content('Photos/beach.jpg'))).toBe('sand and sea');
        expect(drive.trashed().map((trashed) => trashed.uid)).toEqual([oldUid]);
        expect(migration).toEqual({ migrated: 1, finished: 0, alreadyV4: 0, wouldMigrate: 0, failed: 0 });
        expect(lines).toEqual(['migrated Photos/beach.jpg']);
    });

    test('never permanently deletes: the old node stays in the trash with its content', async () => {
        const oldUid = addFile('Photos/beach.jpg', 'sand and sea', 'argon2');

        await run('Photos');

        const [old] = drive.trashed();
        expect(old!.uid).toBe(oldUid);
        expect(old!.nodeKeyVersion).toBe(6);
    });

    test('a v6 key locked with iterated S2K counts too, and a v4 key locked with Argon2 does', async () => {
        addFile('Photos/a.jpg', 'a', 'argon2');
        addFile('Photos/b.jpg', 'b', 'v4');

        const { migration } = await run('Photos');

        expect(migration.migrated).toBe(1);
        expect(migration.alreadyV4).toBe(1);
    });

    test('walks the subfolders of the folder', async () => {
        addFile('Photos/2026/trip/beach.jpg', 'sand', 'argon2');
        addFile('Photos/top.jpg', 'top', 'argon2');
        addFile('Elsewhere/other.jpg', 'other', 'argon2');

        const { migration } = await run('Photos');

        expect(migration.migrated).toBe(2);
        expect(drive.nodeAt('Photos/2026/trip/beach.jpg').nodeKeyVersion).toBe(4);
        expect(drive.nodeAt('Photos/top.jpg').nodeKeyVersion).toBe(4);
        expect(drive.nodeAt('Elsewhere/other.jpg').nodeKeyVersion).toBe(6);
    });

    test('the empty path migrates the whole of My files', async () => {
        addFile('a.jpg', 'a', 'argon2');

        const { migration } = await run('');

        expect(migration.migrated).toBe(1);
    });

    test('a file the SDK gives no size for is not listed, so it is left alone', async () => {
        drive.add('Photos/nosize.jpg', { type: 'file', content: text('x'), nodeKey: 'argon2', clearTextSize: false });

        const { migration } = await run('Photos');

        expect(migration).toEqual({ migrated: 0, finished: 0, alreadyV4: 0, wouldMigrate: 0, failed: 0 });
        expect(drive.nodeAt('Photos/nosize.jpg').nodeKeyVersion).toBe(6);
    });
});

describe('a v4 file', () => {
    test('is the same node as before, and no call touches it', async () => {
        const uid = addFile('Photos/dune.jpg', 'dry sand', 'v4');

        const { migration, lines } = await run('Photos');

        expect(drive.nodeAt('Photos/dune.jpg').uid).toBe(uid);
        expect(drive.trashed()).toEqual([]);
        expect(migration.alreadyV4).toBe(1);
        expect(lines).toEqual([]);
    });

    test('a second run after a migration finds nothing to do', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');
        await run('Photos');
        const uid = drive.nodeAt('Photos/beach.jpg').uid;

        const { migration } = await run('Photos');

        expect(migration).toEqual({ migrated: 0, finished: 0, alreadyV4: 1, wouldMigrate: 0, failed: 0 });
        expect(drive.nodeAt('Photos/beach.jpg').uid).toBe(uid);
        expect(drive.trashed()).toHaveLength(1);
    });
});

describe('--dry-run', () => {
    test('names what it would migrate and changes nothing on the Drive', async () => {
        const uid = addFile('Photos/beach.jpg', 'sand', 'argon2');
        addFile('Photos/dune.jpg', 'dry', 'v4');
        const before = readFileSync(join(dir, 'drive.json'), 'utf8');
        const sdk = new FakeDriveClient(drive);

        const { migration, lines } = await run('Photos', { dryRun: true }, () => sdk);

        expect(lines).toEqual(['would migrate Photos/beach.jpg']);
        expect(migration).toEqual({ migrated: 0, finished: 0, alreadyV4: 1, wouldMigrate: 1, failed: 0 });
        expect(readFileSync(join(dir, 'drive.json'), 'utf8')).toBe(before);
        expect(drive.nodeAt('Photos/beach.jpg').uid).toBe(uid);
        expect(sdk.calls().methods.getFileDownloader).toBeUndefined();
    });

    test('names a file a run left under its temporary name as one it would finish', async () => {
        addFile(`Photos/beach.jpg${TEMPORARY_SUFFIX}`, 'sand', 'v4');

        const { migration, lines } = await run('Photos', { dryRun: true });

        expect(lines).toEqual(['would finish Photos/beach.jpg']);
        expect(migration.wouldMigrate).toBe(1);
        expect(drive.nodeAt(`Photos/beach.jpg${TEMPORARY_SUFFIX}`).name).toBe(`beach.jpg${TEMPORARY_SUFFIX}`);
    });
});

describe('a run that stopped half way', () => {
    test('a verified copy under the temporary name, with the old node gone: the re-run renames it', async () => {
        const copyUid = addFile(`Photos/beach.jpg${TEMPORARY_SUFFIX}`, 'sand', 'v4');

        const { migration, lines } = await run('Photos');

        expect(drive.nodeAt('Photos/beach.jpg').uid).toBe(copyUid);
        expect(migration).toEqual({ migrated: 0, finished: 1, alreadyV4: 0, wouldMigrate: 0, failed: 0 });
        expect(lines).toEqual(['finished Photos/beach.jpg']);
    });

    test('a copy and the old node with equal content: the re-run trashes the old node and renames the copy, without a second upload', async () => {
        const oldUid = addFile('Photos/beach.jpg', 'sand', 'argon2');
        const copyUid = addFile(`Photos/beach.jpg${TEMPORARY_SUFFIX}`, 'sand', 'v4');
        const sdk = new FakeDriveClient(drive);

        const { migration, lines } = await run('Photos', {}, () => sdk);

        expect(drive.nodeAt('Photos/beach.jpg').uid).toBe(copyUid);
        expect(trashedNames()).toEqual(['beach.jpg']);
        expect(drive.trashed()[0]!.uid).toBe(oldUid);
        expect(sdk.calls().methods.getFileUploader).toBeUndefined();
        expect(migration.finished).toBe(1);
        expect(lines).toEqual(['finished Photos/beach.jpg']);
    });

    test('a copy whose content differs from the old node: it is trashed and the file migrated afresh', async () => {
        const oldUid = addFile('Photos/beach.jpg', 'sand and sea', 'argon2');
        const partialUid = addFile(`Photos/beach.jpg${TEMPORARY_SUFFIX}`, 'sand', 'v4');

        const { migration } = await run('Photos');

        expect(decode(drive.content('Photos/beach.jpg'))).toBe('sand and sea');
        expect(drive.nodeAt('Photos/beach.jpg').nodeKeyVersion).toBe(4);
        expect(drive.trashed().map((node) => node.uid).sort()).toEqual([oldUid, partialUid].sort());
        expect(migration.migrated).toBe(1);
    });

    test('a copy of the same length but other bytes counts as different', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');
        addFile(`Photos/beach.jpg${TEMPORARY_SUFFIX}`, 'sane', 'v4');

        await run('Photos');

        expect(decode(drive.content('Photos/beach.jpg'))).toBe('sand');
    });

    test('a v4 file with a leftover copy is not ours to migrate: both stay and the run says so', async () => {
        const uid = addFile('Photos/beach.jpg', 'sand', 'v4');
        const copyUid = addFile(`Photos/beach.jpg${TEMPORARY_SUFFIX}`, 'sand', 'v4');

        const { migration, lines } = await run('Photos');

        expect(drive.nodeAt('Photos/beach.jpg').uid).toBe(uid);
        expect(drive.nodeAt(`Photos/beach.jpg${TEMPORARY_SUFFIX}`).uid).toBe(copyUid);
        expect(drive.trashed()).toEqual([]);
        expect(migration.alreadyV4).toBe(1);
        expect(lines).toEqual([`left alone Photos/beach.jpg${TEMPORARY_SUFFIX}: the file beach.jpg already has a v4 node key`]);
    });

    test('a file under the temporary name that holds a v6 key is not ours: it is left alone', async () => {
        addFile(`Photos/beach.jpg${TEMPORARY_SUFFIX}`, 'sand', 'argon2');

        const { migration, lines } = await run('Photos');

        expect(drive.nodeAt(`Photos/beach.jpg${TEMPORARY_SUFFIX}`).nodeKeyVersion).toBe(6);
        expect(migration).toEqual({ migrated: 0, finished: 0, alreadyV4: 0, wouldMigrate: 0, failed: 0 });
        expect(lines).toEqual([`left alone Photos/beach.jpg${TEMPORARY_SUFFIX}: it holds a version 6 node key`]);
    });
});

describe('a file that fails', () => {
    test('a v6 file under the temporary name, in the way of a v6 original, is not trashed: the original fails', async () => {
        const oldUid = addFile('Photos/beach.jpg', 'sand', 'argon2');
        const strayUid = addFile(`Photos/beach.jpg${TEMPORARY_SUFFIX}`, 'sand', 'argon2');

        const { migration, lines } = await run('Photos');

        expect(migration.failed).toBe(1);
        expect(lines[0]).toMatch(/^failed Photos\/beach\.jpg: .*is in the way.*version 6/);
        expect(drive.nodeAt('Photos/beach.jpg').uid).toBe(oldUid);
        expect(drive.nodeAt(`Photos/beach.jpg${TEMPORARY_SUFFIX}`).uid).toBe(strayUid);
        expect(drive.trashed()).toEqual([]);
    });

    test('a file with no bytes migrates too', async () => {
        addFile('Photos/empty.txt', '', 'argon2', 'text/plain');

        const { migration } = await run('Photos');

        expect(migration.migrated).toBe(1);
        expect(drive.content('Photos/empty.txt')).toHaveLength(0);
    });

    test('a stored SHA1 the download does not match: the old node stays, no copy is kept, and the run goes on', async () => {
        const oldUid = addFile('Photos/beach.jpg', 'sand', 'argon2');
        addFile('Photos/dune.jpg', 'dry', 'argon2');
        const lying = replacing('iterateNodes', (original) =>
            (async function* (uids: string[]) {
                for await (const node of original(uids)) {
                    const entity = node as { name?: { value: string }; activeRevision?: object };
                    if (entity.name?.value === 'beach.jpg') {
                        yield { ...entity, activeRevision: { ...entity.activeRevision, claimedDigests: { sha1: '0'.repeat(40) } } } as never;
                    } else {
                        yield node;
                    }
                }
            }) as never,
        );

        const { migration, lines } = await run('Photos', {}, lying);

        expect(drive.nodeAt('Photos/beach.jpg').uid).toBe(oldUid);
        expect(drive.trashed().map((node) => node.name).sort()).toEqual([`beach.jpg${TEMPORARY_SUFFIX}`, 'dune.jpg']);
        expect(drive.nodeAt('Photos/dune.jpg').nodeKeyVersion).toBe(4);
        expect(migration).toMatchObject({ migrated: 1, failed: 1 });
        expect(lines[0]).toMatch(/^failed Photos\/beach\.jpg: .*SHA1/);
    });

    test('a stored SHA1 the download matches lets the file through', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');
        const sha1 = new Bun.CryptoHasher('sha1').update('sand').digest('hex');
        const honest = replacing('iterateNodes', (original) =>
            (async function* (uids: string[]) {
                for await (const node of original(uids)) {
                    const entity = node as { activeRevision?: object };
                    yield { ...entity, activeRevision: { ...entity.activeRevision, claimedDigests: { sha1 } } } as never;
                }
            }) as never,
        );

        const { migration } = await run('Photos', {}, honest);

        expect(migration.migrated).toBe(1);
    });

    test('a new node whose content differs from the old: the old stays, the new goes to the trash', async () => {
        const oldUid = addFile('Photos/beach.jpg', 'sand', 'argon2');
        const corrupting = replacing('getFileUploader', (original) =>
            (async (parent: string, name: string, metadata: object, signal?: AbortSignal) => {
                const uploader = await original(parent, name, metadata, signal);
                return {
                    ...uploader,
                    uploadFromStream: (stream: ReadableStream<Uint8Array>, thumbnails: unknown[], onProgress?: () => void) =>
                        uploader.uploadFromStream(
                            stream.pipeThrough(
                                new TransformStream({
                                    transform(chunk, controller) {
                                        controller.enqueue(chunk.map((byte: number) => byte ^ 1));
                                    },
                                }),
                            ),
                            thumbnails,
                            onProgress,
                        ),
                };
            }) as never,
        );

        const { migration, lines } = await run('Photos', {}, corrupting);

        expect(drive.nodeAt('Photos/beach.jpg').uid).toBe(oldUid);
        expect(trashedNames()).toEqual([`beach.jpg${TEMPORARY_SUFFIX}`]);
        expect(migration.failed).toBe(1);
        expect(lines[0]).toMatch(/^failed Photos\/beach\.jpg: .*differs/);
    });

    test('a new node whose key is not v4: the old stays', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');
        const argon = replacing('getNode', (original) =>
            (async (uid: string) => {
                const node = await original(uid);
                return { ...node, encryptedCrypto: { armoredKey: armoredNodeKey('argon2') } } as never;
            }) as never,
        );

        const { migration, lines } = await run('Photos', {}, argon);

        expect(migration.failed).toBe(1);
        expect(lines[0]).toMatch(/^failed Photos\/beach\.jpg: .*not a v4 key/);
        expect(drive.nodeAt('Photos/beach.jpg').nodeKeyVersion).toBe(6);
    });

    test('an upload that fails leaves the old node and no copy', async () => {
        const oldUid = addFile('Photos/beach.jpg', 'sand', 'argon2');
        const failing = replacing('getFileUploader', () => (async () => Promise.reject(new Error('upload refused'))) as never);

        const { migration, lines } = await run('Photos', {}, failing);

        expect(drive.nodeAt('Photos/beach.jpg').uid).toBe(oldUid);
        expect(drive.trashed()).toEqual([]);
        expect(migration.failed).toBe(1);
        expect(lines).toEqual(['failed Photos/beach.jpg: upload refused']);
    });

    test('a trash that fails keeps the verified copy for the next run to finish', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');
        const failing = replacing('trashNodes', () =>
            (async function* (uids: string[]) {
                for (const uid of uids as Array<string | { uid: string }>) yield { uid: typeof uid === 'string' ? uid : uid.uid, ok: false, error: new Error('trash refused') };
            }) as never,
        );

        const { migration, lines } = await run('Photos', {}, failing);

        expect(migration.failed).toBe(1);
        expect(lines).toEqual(['failed Photos/beach.jpg: trash refused']);
        expect(drive.nodeAt(`Photos/beach.jpg${TEMPORARY_SUFFIX}`).nodeKeyVersion).toBe(4);
        expect(drive.nodeAt('Photos/beach.jpg').nodeKeyVersion).toBe(6);

        const rerun = await run('Photos');

        expect(rerun.migration.finished).toBe(1);
        expect(drive.nodeAt('Photos/beach.jpg').nodeKeyVersion).toBe(4);
    });

    test('a rename that fails leaves the copy under its temporary name for the next run to finish', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');
        const failing = replacing('renameNode', () => (async () => Promise.reject(new Error('rename refused'))) as never);

        const { migration } = await run('Photos', {}, failing);

        expect(migration.failed).toBe(1);
        expect(drive.trashed()).toHaveLength(1);

        const rerun = await run('Photos');

        expect(rerun.migration.finished).toBe(1);
        expect(decode(drive.content('Photos/beach.jpg'))).toBe('sand');
    });

    test('a file that cannot be downloaded fails by itself', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');
        const failing = replacing('getFileDownloader', () => (async () => Promise.reject(new Error('no blocks'))) as never);

        const { migration, lines } = await run('Photos', {}, failing);

        expect(migration.failed).toBe(1);
        expect(lines).toEqual(['failed Photos/beach.jpg: no blocks']);
    });

    test('a node key that cannot be read fails the file, not the run', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');
        const garbled = replacing('iterateNodes', (original) =>
            (async function* (uids: string[]) {
                for await (const node of original(uids)) yield { ...(node as object), encryptedCrypto: { armoredKey: 'garbage' } } as never;
            }) as never,
        );

        const { migration, lines } = await run('Photos', {}, garbled);

        expect(migration.failed).toBe(1);
        expect(lines[0]).toMatch(/^failed Photos\/beach\.jpg: /);
    });

    test('a file whose node key the SDK does not show is counted as failed, not skipped in silence', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');
        const blind = replacing('iterateNodes', (original) =>
            (async function* (uids: string[]) {
                for await (const node of original(uids)) yield { ...(node as object), encryptedCrypto: undefined } as never;
            }) as never,
        );

        const { migration, lines } = await run('Photos', {}, blind);

        expect(migration.failed).toBe(1);
        expect(lines).toEqual(['failed Photos/beach.jpg: the SDK shows no node key for it']);
    });
});

describe('the folder to migrate', () => {
    test('a folder that does not exist is an error', async () => {
        await expect(run('Nowhere')).rejects.toThrow('/Nowhere not found');
    });

    test('a file where a folder is asked for is an error', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');

        await expect(run('Photos/beach.jpg')).rejects.toThrow('/Photos/beach.jpg is not a folder');
    });
});

describe('a rate limit', () => {
    test('waits out the pause Proton asks for, then goes on', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');
        let limited = false;
        let now = 1_000_000;
        const limiting = replacing('getFileUploader', (original) =>
            (async (...args: Parameters<SdkSurface['getFileUploader']>) => {
                if (!limited) {
                    limited = true;
                    throw new RateLimitedError('too many requests');
                }
                return original(...args);
            }) as never,
        );
        const sdk = limiting(new FakeDriveClient(drive));
        const backoff = new Backoff(() => now);
        const tree = new DriveTree(sdk, QUIET, backoff);
        const sleeps: number[] = [];

        const migration = await migrateNodeKeys({
            sdk,
            tree,
            logger: QUIET,
            folder: ['Photos'],
            dryRun: false,
            report: () => {},
            sleep: async (ms) => {
                sleeps.push(ms);
                now += ms;
            },
        });

        expect(migration.migrated).toBe(1);
        expect(sleeps).toEqual([30_000]);
    });

    test('gives up on a file after the pause came back ten times', async () => {
        addFile('Photos/beach.jpg', 'sand', 'argon2');
        const limiting = replacing('getFileUploader', () => (async () => Promise.reject(new RateLimitedError('too many requests'))) as never);
        let now = 1_000_000;
        const sdk = limiting(new FakeDriveClient(drive));

        const migration = await migrateNodeKeys({
            sdk,
            tree: new DriveTree(sdk, QUIET, new Backoff(() => now)),
            logger: QUIET,
            folder: ['Photos'],
            dryRun: false,
            report: () => {},
            sleep: async (ms) => {
                now += ms;
            },
        });

        expect(migration.failed).toBe(1);
    });
});
