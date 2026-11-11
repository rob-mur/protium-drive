import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

import { type DriveEvent, DriveEventType, RateLimitedError } from '@protontech/drive-sdk';

import type { SessionCredentials, SessionInfo } from '../vendor/proton-drive-sdk-account/sessionCredentials.ts';
import { FakeAccount } from './account.ts';
import { FakeClock } from './clock.ts';
import { type ControlChannel, startControlChannel } from './control.ts';
import { FakeDrive, FakeDriveClient, SCOPE_ID } from './drive.ts';
import { Faults } from './faults.ts';

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

    test('replaces a file as another client, with the modification time its upload claims', async () => {
        await json(post('/add', { path: 'a.txt', type: 'file', content: 'aaaa' }));
        await json(post('/add', { path: 'a.txt', type: 'file', content: 'bbbb', modificationTime: '2026-06-01T00:00:00.000Z' }));

        expect(await json(get(`/revisions${query('a.txt')}`))).toMatchObject([
            { state: 'superseded', size: 4 },
            { state: 'active', size: 4, claimedModificationTime: '2026-06-01T00:00:00.000Z' },
        ]);
        expect(await (await get(`/content${query('a.txt')}`)).text()).toBe('bbbb');
        const { activeRevision } = await client.getNode(drive.nodeAt('a.txt').uid);
        expect(activeRevision?.claimedModificationTime).toEqual(new Date('2026-06-01T00:00:00.000Z'));
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

    test('adds a file with an Argon2-locked or a v4 node key, and reads the key’s version back', async () => {
        await json(post('/add', { path: 'Photos/old.jpg', type: 'file', content: 'a', nodeKey: 'argon2' }));
        await json(post('/add', { path: 'Photos/new.jpg', type: 'file', content: 'b', nodeKey: 'v4' }));
        await json(post('/add', { path: 'Photos/plain.jpg', type: 'file', content: 'c' }));

        expect(await json(get(`/node${query('Photos/old.jpg')}`))).toMatchObject({ nodeKey: 'argon2', nodeKeyVersion: 6 });
        expect(await json(get(`/node${query('Photos/new.jpg')}`))).toMatchObject({ nodeKey: 'v4', nodeKeyVersion: 4 });
        expect(await json(get(`/node${query('Photos/plain.jpg')}`))).toMatchObject({ nodeKeyVersion: 4 });
        expect((await post('/add', { path: 'Photos/odd.jpg', type: 'file', content: 'x', nodeKey: 'v5' })).status).toBe(400);
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
            { path: 'x.bin', type: 'file', content: 'x', modificationTime: 'yesterday' },
            { path: 'x.bin', type: 'file', content: 'x', modificationTime: 5 },
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

describe('the control channel of the clock, the faults and the account', () => {
    let clock: FakeClock;
    let faults: Faults;
    let account: FakeAccount;
    let full: ControlChannel;

    beforeEach(() => {
        clock = new FakeClock(1_000_000);
        faults = new Faults();
        account = FakeAccount.open(dir);
        client = new FakeDriveClient(drive, { clock, faults, account });
        full = startControlChannel(drive, client, { clock, faults, account });
    });

    afterEach(async () => {
        await full.stop();
    });

    const at = (path: string) => new URL(path, full.url);
    const send = (path: string, body?: unknown) => fetch(at(path), { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

    test('moves the clock by a number of seconds, and fires each timer that falls due', async () => {
        const fired: number[] = [];
        clock.setTimeout(() => fired.push(clock.now()), 30_000);
        clock.setTimeout(() => fired.push(clock.now()), 31_000);

        expect(await json(fetch(at('/clock')))).toEqual({ now: 1_000_000 });
        expect(await json(send('/clock/advance', { seconds: 30 }))).toEqual({ now: 1_030_000, fired: 1 });
        expect(fired).toEqual([1_030_000]);
        expect(await json(send('/clock/advance', { seconds: 0.5 }))).toEqual({ now: 1_030_500, fired: 0 });
        for (const body of [{}, { seconds: -1 }, { seconds: '30' }, { seconds: null }, { seconds: 1e306 }]) {
            expect((await send('/clock/advance', body)).status).toBe(400);
        }
        expect(clock.now()).toBe(1_030_500);
    });

    test('sets a fault, lists it until a call consumes it, and refuses a fault that cannot occur', async () => {
        await json(post('/add', { path: 'Photos/beach.jpg', type: 'file', content: 'sand and sea' }));
        const fault = { kind: 'rate-limited', operation: 'iterateFolderChildrenNodeUids', path: 'Photos' };
        expect(await json(send('/faults', fault))).toEqual({ pending: [fault] });
        expect(await json(fetch(at('/faults')))).toEqual([fault]);

        const listing = client.iterateFolderChildrenNodeUids(drive.nodeAt('Photos').uid);
        await expect(listing.next()).rejects.toBeInstanceOf(RateLimitedError);
        expect(await json(fetch(at('/faults')))).toEqual([]);

        for (const bad of [{ ...fault, kind: 'meteor' }, { ...fault, operation: 'nope' }, { kind: 'integrity', operation: 'getNode', path: 'a' }]) {
            const response = await send('/faults', bad);
            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error: expect.any(String) });
        }
        expect((await send('/faults', 'not json')).status).toBe(400);
    });

    test('approves a waiting sign-in, and answers 409 when none waits', async () => {
        expect((await send('/account/approve')).status).toBe(409);
        const { auth } = await account.initAccount({ authClientId: 'external-drive', credentials: memoryCredentials() });
        const urls: string[] = [];
        const done = auth.authViaWeb((url) => void urls.push(url));
        while (urls.length === 0) await Bun.sleep(1);
        expect(await json(fetch(at('/account')))).toMatchObject({ signIns: { started: 1, approved: 0, pending: 1 } });
        expect(await json(send('/account/approve'))).toEqual({ approved: 1 });
        expect((await done).refreshToken).toBe('refresh-1');
    });

    test('expires the access token, refuses the next refresh, and reports which token each refresh used', async () => {
        const credentials = memoryCredentials();
        const { auth } = await account.initAccount({ authClientId: 'external-drive', credentials });
        const done = auth.authViaWeb(() => void setTimeout(() => account.approve(), 1));
        await done;

        expect(await json(send('/account/expire'))).toEqual({ expired: 1 });
        await client.getMyFilesRootFolder();
        expect(await json(send('/account/refuse-next-refresh'))).toEqual({ refuseNextRefresh: true });
        await json(send('/account/expire'));
        await expect(client.getMyFilesRootFolder()).rejects.toMatchObject({ statusCode: 401 });

        expect(await json(fetch(at('/account')))).toEqual({
            signIns: { started: 1, approved: 1, pending: 0 },
            refreshes: [
                { used: 'refresh-1', outcome: 'rotated' },
                { used: 'refresh-2', outcome: 'refused' },
            ],
            refuseNextRefresh: false,
        });
    });

    test('a channel started with no clock, faults or account has none of their routes', async () => {
        for (const [method, path] of [['GET', '/clock'], ['POST', '/clock/advance'], ['GET', '/faults'], ['POST', '/faults'], ['GET', '/account'], ['POST', '/account/approve']]) {
            expect((await fetch(new URL(path!, control.url), { method })).status).toBe(404);
        }
    });
});

function memoryCredentials(): SessionCredentials {
    let keyPassword: string | undefined;
    let info: SessionInfo | undefined;
    return {
        get uid() {
            return info?.uid;
        },
        get accessToken() {
            return info?.accessToken;
        },
        get refreshToken() {
            return info?.refreshToken;
        },
        on: () => {},
        isLoggedIn: () => !!keyPassword && !!info,
        isTelemetryEnabled: () => false,
        getUserKeyPassword: () => keyPassword,
        load: async () => {},
        setUserKeyPassword: async (value) => void (keyPassword = value),
        setSessionInfo: async (value) => void (info = value),
        setTelemetryEnabled: async () => {},
        signOut: async () => {
            keyPassword = undefined;
            info = undefined;
        },
    };
}
