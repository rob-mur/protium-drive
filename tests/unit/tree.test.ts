import { describe, expect, test } from 'bun:test';

import { RateLimitedError, ValidationError } from '@protontech/drive-sdk';

import { EventWatcher } from '../../src/drive/events';
import { DriveTree } from '../../src/drive/tree';
import { silentLogger } from '../../src/logger';
import { FakeDriveSdk } from '../support/fakeSdk';

function setup(rootPath?: string[]) {
    const fake = new FakeDriveSdk();
    const tree = new DriveTree(fake, silentLogger(), { rootPath });
    return { fake, tree };
}

describe('DriveTree cache', () => {
    test('lists each folder once until something changes it', async () => {
        const { fake, tree } = setup();
        fake.remoteWrite('a/one.txt', '1');
        fake.remoteWrite('a/two.txt', '22');
        const a = (await tree.stat(['a']))!;
        expect((await tree.list(a)).map((e) => e.name).sort()).toEqual(['one.txt', 'two.txt']);
        const before = fake.count('iterateFolderChildrenNodeUids');
        await tree.stat(['a', 'one.txt']);
        await tree.list(a);
        expect(fake.count('iterateFolderChildrenNodeUids')).toBe(before);
    });

    test('hides trashed nodes and maps sizes and revisions', async () => {
        const { fake, tree } = setup();
        fake.remoteWrite('keep.txt', 'hello');
        fake.remoteWrite('gone.txt', 'x');
        fake.remoteTrash('gone.txt');
        const root = await tree.root();
        const entries = await tree.list(root);
        expect(entries.map((e) => e.name)).toEqual(['keep.txt']);
        expect(entries[0]).toMatchObject({ kind: 'file', size: 5 });
        expect(entries[0].revisionUid).toEndWith('~r1');
    });

    test('serves a --root folder as /', async () => {
        const { fake, tree } = setup(['Photos', 'immich']);
        fake.remoteWrite('Photos/immich/library/a.jpg', 'jpg');
        fake.remoteWrite('outside.txt', 'no');
        expect((await tree.list(await tree.root())).map((e) => e.name)).toEqual(['library']);
        expect(await tree.stat(['outside.txt'])).toBeUndefined();
    });

    test('a missing --root folder fails clearly', async () => {
        const { tree } = setup(['nope']);
        await expect(tree.root()).rejects.toThrow('/nope does not exist');
    });

    test('upload of an existing name makes a new revision, not a second file', async () => {
        const { fake, tree } = setup();
        fake.remoteWrite('doc.txt', 'v1');
        const body = new Response('version 2').body!;
        const result = await tree.upload([], 'doc.txt', body, { size: 9, mediaType: 'text/plain' });
        expect(result.created).toBe(false);
        expect(fake.byPath('doc.txt').revision).toBe(2);
        expect(fake.text('doc.txt')).toBe('version 2');
        expect((await tree.stat(['doc.txt']))?.size).toBe(9);
        expect(fake.count('getFileRevisionUploader')).toBe(1);
    });

    test('a move whose rename fails still drops the stale listings', async () => {
        const { fake, tree } = setup();
        fake.remoteWrite('a/x.txt', 'x');
        fake.remoteMkdirp(['b']);
        expect(await tree.stat(['a', 'x.txt'])).toBeDefined();
        expect(await tree.stat(['b', 'x.txt'])).toBeUndefined();
        fake.renameNode = async () => {
            throw new ValidationError('rename refused');
        };
        await expect(tree.move(['a', 'x.txt'], ['b', 'y.txt'], false)).rejects.toThrow('rename refused');
        // Proton moved the file but kept its name; the cache must show that.
        expect(await tree.stat(['a', 'x.txt'])).toBeUndefined();
        expect(await tree.stat(['b', 'x.txt'])).toBeDefined();
    });

    test('refuses to move an entry onto a folder that contains it', async () => {
        const { fake, tree } = setup();
        fake.remoteWrite('a/b/c.txt', 'c');
        await expect(tree.move(['a', 'b'], ['a'], true)).rejects.toThrow('contains it');
        expect(fake.trashedNames()).toEqual([]);
        expect(await tree.stat(['a', 'b', 'c.txt'])).toBeDefined();
    });
});

describe('EventWatcher', () => {
    test('starts from the latest event, then drops only the listings that changed', async () => {
        const { fake, tree } = setup();
        fake.remoteWrite('a/old.txt', 'x');
        fake.remoteWrite('b/other.txt', 'y');
        const watcher = new EventWatcher(fake, tree, silentLogger());
        await watcher.start();
        await fake.scheduler!.pollNow();
        expect(fake.scheduler!.scopes.has('volume-1')).toBe(true);

        const a = (await tree.stat(['a']))!;
        await tree.list(a);
        await tree.list((await tree.stat(['b']))!);
        expect((await tree.list(a)).map((e) => e.name)).toEqual(['old.txt']);

        fake.remoteWrite('a/new.txt', 'z');
        const listingsBefore = fake.count('iterateFolderChildrenNodeUids');
        await fake.scheduler!.pollNow();
        expect((await tree.list(a)).map((e) => e.name).sort()).toEqual(['new.txt', 'old.txt']);
        // Only folder "a" was listed again; "b" and the root stay cached.
        await tree.list((await tree.stat(['b']))!);
        expect(fake.count('iterateFolderChildrenNodeUids')).toBe(listingsBefore + 1);
        watcher.stop();
        expect(fake.scheduler!.scopes.size).toBe(0);
    });

    test('the first poll drops listings loaded before it', async () => {
        const { fake, tree } = setup();
        fake.remoteWrite('a/old.txt', 'x');
        // No session yet, so the first scheduled poll makes no request.
        let signedIn = false;
        const watcher = new EventWatcher(fake, tree, silentLogger(), () => signedIn);
        await watcher.start();
        const a = (await tree.stat(['a']))!;
        expect((await tree.list(a)).map((e) => e.name)).toEqual(['old.txt']);
        // A change before the first real poll: that poll starts after it.
        fake.remoteWrite('a/new.txt', 'z');
        signedIn = true;
        await fake.scheduler!.pollNow();
        expect((await tree.list(a)).map((e) => e.name).sort()).toEqual(['new.txt', 'old.txt']);
        watcher.stop();
    });

    test('a remote trash removes the file from the listing', async () => {
        const { fake, tree } = setup();
        fake.remoteWrite('a.txt', 'x');
        const watcher = new EventWatcher(fake, tree, silentLogger());
        await watcher.start();
        await fake.scheduler!.pollNow();
        expect(await tree.stat(['a.txt'])).toBeDefined();
        fake.remoteTrash('a.txt');
        await fake.scheduler!.pollNow();
        expect(await tree.stat(['a.txt'])).toBeUndefined();
        watcher.stop();
    });

    test('a rate-limited poll starts the cool-down and later polls are skipped', async () => {
        const { fake, tree } = setup();
        const watcher = new EventWatcher(fake, tree, silentLogger());
        await watcher.start();
        await fake.scheduler!.pollNow();
        fake.rateLimitCalls = 1;
        await fake.scheduler!.pollNow();
        expect(tree.backoff.coolingDownSeconds).toBeGreaterThan(0);
        const polls = fake.count('iterateEvents');
        await fake.scheduler!.pollNow();
        expect(fake.count('iterateEvents')).toBe(polls);
        watcher.stop();
    });

    test('makes no request while the session is gone', async () => {
        const { fake, tree } = setup();
        let signedIn = true;
        const watcher = new EventWatcher(fake, tree, silentLogger(), () => signedIn);
        await watcher.start();
        await fake.scheduler!.pollNow();
        signedIn = false;
        const polls = fake.count('iterateEvents');
        await fake.scheduler!.pollNow();
        expect(fake.count('iterateEvents')).toBe(polls);
        watcher.stop();
    });

    test('poll never throws', async () => {
        const { fake, tree } = setup();
        const watcher = new EventWatcher(fake, tree, silentLogger());
        await watcher.start();
        fake.iterateEvents = async function* () {
            throw new RateLimitedError('x');
        };
        await expect(watcher.poll('volume-1')).resolves.toBeUndefined();
        watcher.stop();
    });
});
