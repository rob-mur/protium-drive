import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

import { type DriveEvent, DriveEventType } from '@protontech/drive-sdk';

import { type ControlChannel, startControlChannel } from './control.ts';
import { FakeDrive, FakeDriveClient, SCOPE_ID } from './drive.ts';

let dir: string;
let drive: FakeDrive;
let client: FakeDriveClient;
let control: ControlChannel;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-drive-control-'));
    drive = FakeDrive.open(dir);
    client = new FakeDriveClient(drive);
    control = startControlChannel(drive, client);
});

afterEach(async () => {
    await control.stop();
    rmSync(dir, { recursive: true, force: true });
});

const get = (path: string) => fetch(new URL(path, control.url));
const post = (path: string, body?: unknown) =>
    fetch(new URL(path, control.url), { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (response: Response | Promise<Response>) => {
    const res = await response;
    expect(res.status).toBe(200);
    return res.json();
};
const query = (path: string) => `?path=${encodeURIComponent(path)}`;

describe('the control channel', () => {
    test('listens on 127.0.0.1 at a port it allocates, and nowhere else', async () => {
        expect(control.url.hostname).toBe('127.0.0.1');
        expect(Number(control.url.port)).toBeGreaterThan(0);

        const others = Object.values(networkInterfaces())
            .flat()
            .filter((address) => address && address.family === 'IPv4' && !address.internal);
        for (const address of others) {
            await expect(fetch(`http://${address!.address}:${control.url.port}/trash`)).rejects.toThrow();
        }
    });

    test('adds a file as another client, and reads its node, content and revisions', async () => {
        const { uid } = await json(post('/add', { path: 'Docs/a.txt', type: 'file', content: 'one', mediaType: 'text/plain' }));
        await json(post('/add', { path: 'Docs/a.txt', type: 'file', contentBase64: btoa('two!') }));

        const node = await json(get(`/node${query('Docs/a.txt')}`));
        expect(node).toMatchObject({ uid, path: 'Docs/a.txt', name: 'a.txt', type: 'file', revisionCount: 2 });

        const revisions = await json(get(`/revisions${query('Docs/a.txt')}`));
        expect(revisions).toMatchObject([
            { state: 'superseded', size: 3, declaredSize: 3, mediaType: 'text/plain' },
            { state: 'active', size: 4, declaredSize: 4, mediaType: 'application/octet-stream' },
        ]);
        expect(await (await get(`/content${query('Docs/a.txt')}`)).text()).toBe('two!');
        expect(await (await get(`/content${query('Docs/a.txt')}&revision=${revisions[0].uid}`)).text()).toBe('one');
    });

    test('adds the nodes the product must hide', async () => {
        await json(post('/add', { path: 'secret', type: 'file', content: 'x', nameUndecryptable: true }));
        await json(post('/add', { path: 'sizeless', type: 'file', content: 'x', clearTextSize: false }));
        await json(post('/add', { path: 'Empty', type: 'folder' }));

        const secret = await client.getNode(drive.nodeAt('secret').uid);
        const sizeless = await client.getNode(drive.nodeAt('sizeless').uid);
        expect(secret.name.ok).toBe(false);
        expect(sizeless.activeRevision?.claimedSize).toBeUndefined();
        expect(await json(get(`/node${query('Empty')}`))).toMatchObject({ type: 'folder', revisionCount: 0 });
    });

    test('renames and trashes as another client, reads the trash, and fires the event scheduler', async () => {
        const polls: DriveEvent[][] = [];
        let lastEventId: string | undefined;
        const scheduler = await client.getEventScheduler(async (scope) => {
            const got: DriveEvent[] = [];
            for await (const event of client.iterateEvents(scope, lastEventId)) {
                got.push(event);
                lastEventId = event.eventId;
            }
            polls.push(got);
        });
        scheduler.addScope(SCOPE_ID);

        const { uid } = await json(post('/add', { path: 'a.txt', type: 'file', content: 'a' }));
        expect(await json(post('/rename', { path: 'a.txt', name: 'b.txt' }))).toEqual({ uid });
        expect(await json(post('/trash', { path: 'b.txt' }))).toEqual({ uid });
        expect(await json(post('/events/fire'))).toEqual({ scopes: [SCOPE_ID] });

        expect(polls).toHaveLength(2);
        expect(polls[1]).toMatchObject([
            { type: DriveEventType.NodeCreated, nodeUid: uid },
            { type: DriveEventType.NodeUpdated, nodeUid: uid, isTrashed: false },
            { type: DriveEventType.NodeUpdated, nodeUid: uid, isTrashed: true },
        ]);
        expect(await json(get('/trash'))).toMatchObject([{ uid, name: 'b.txt' }]);
    });

    test('reads the call counts', async () => {
        const root = await client.getMyFilesRootFolder();
        for await (const _ of client.iterateFolderChildrenNodeUids(root)) void _;
        expect(await json(get('/calls'))).toEqual({
            methods: { getMyFilesRootFolder: 1, iterateFolderChildrenNodeUids: 1 },
            listings: { [root.uid]: 1 },
            nodeLoads: {},
            downloads: {},
        });
    });

    test('answers 404 for a path with no node or an unknown route, 409 for a taken name and 400 for a bad request', async () => {
        expect((await get(`/node${query('nope')}`)).status).toBe(404);
        expect((await get('/nope')).status).toBe(404);
        await json(post('/add', { path: 'a', type: 'file', content: '' }));
        await json(post('/add', { path: 'b', type: 'file', content: '' }));
        expect((await post('/rename', { path: 'a', name: 'b' })).status).toBe(409);
        expect((await post('/add', { path: 'c', type: 'file' })).status).toBe(400);
        expect((await post('/add', 'not json')).status).toBe(400);
        expect((await get('/node')).status).toBe(400);
    });

    test('answers 400 with an error for each malformed add', async () => {
        const bad = [
            null,
            { path: 'x.bin', type: 'file', contentBase64: '!!!notbase64' },
            { path: 'x.bin', type: 'file', content: 'x', clearTextSize: 'no' },
            { path: 'x.bin', type: 'file', content: 'x', mediaType: 5 },
        ];
        for (const body of bad) {
            const response = await post('/add', body);
            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error: expect.any(String) });
        }
        expect(await json(get('/node?path='))).toMatchObject({ revisionCount: 0 });
        expect((await get(`/node${query('x.bin')}`)).status).toBe(404);
    });

    test('answers 400 for a trash of My files, and 404 for a revision that does not exist', async () => {
        expect((await post('/trash', { path: '' })).status).toBe(400);
        expect(await json(get('/trash'))).toEqual([]);
        await json(post('/add', { path: 'a.txt', type: 'file', content: 'a' }));
        expect((await get(`/content${query('a.txt')}&revision=nope`)).status).toBe(404);
    });

    test('stops listening when stopped', async () => {
        await control.stop();
        await expect(get('/trash')).rejects.toThrow();
    });
});
