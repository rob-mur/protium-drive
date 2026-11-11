import { describe, expect, test } from 'bun:test';
import { DriveEventType, type DriveEvent, NodeType, type NodeEntity, RateLimitedError } from '@protontech/drive-sdk';

import { Backoff } from './backoff.ts';
import { EventWatcher, START_RETRY_MS } from './events.ts';
import type { DriveSdk } from './sdk.ts';
import type { ListingSnapshot } from './listing-cache.ts';
import { DriveTree } from './tree.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function node(uid: string, name: string, parentUid?: string): NodeEntity {
    return {
        uid,
        parentUid,
        type: NodeType.Folder,
        name: { ok: true, value: name },
        creationTime: new Date(0),
        modificationTime: new Date(0),
        treeEventScopeId: 'scope-1',
    } as NodeEntity;
}

/** An SDK whose folders hold nothing, whose scheduler the test drives, and whose events the test sets. */
function setup(
    options: { startFailures?: number; now?: () => number; authProblem?: () => string | undefined; restore?: ListingSnapshot } = {},
) {
    const calls = { listed: [] as string[], iterated: [] as (string | undefined)[], scopes: [] as string[], schedulers: 0 };
    let events: DriveEvent[] = [];
    let poll: (scope: string) => Promise<void> = async () => {};
    let startFailures = options.startFailures ?? 0;
    let iterateError: unknown;
    const sdk = {
        getMyFilesRootFolder: async () => node('root', 'My files'),
        iterateFolderChildrenNodeUids: async function* (parent: string) {
            calls.listed.push(parent);
        },
        iterateNodes: async function* () {},
        getEventScheduler: async (callback: (scope: string) => Promise<void>) => {
            if (startFailures > 0) {
                startFailures--;
                throw new Error('no scheduler');
            }
            calls.schedulers++;
            poll = callback;
            return { addScope: (scope: string) => calls.scopes.push(scope), removeScope() {} };
        },
        iterateEvents: async function* (_scope: string, last?: string) {
            calls.iterated.push(last);
            if (iterateError) throw iterateError;
            yield* events;
        },
    } as unknown as DriveSdk;
    const backoff = new Backoff(options.now);
    const tree = new DriveTree(sdk, logger, backoff, { restore: options.restore });
    const timers: { callback: () => unknown; ms: number }[] = [];
    const watcher = new EventWatcher(sdk, tree, logger, {
        authProblem: options.authProblem ?? (() => undefined),
        setTimeout: (callback, ms) => timers.push({ callback, ms }),
    });
    return {
        calls,
        timers,
        watcher,
        tree,
        poll: (scope = 'scope-1') => poll(scope),
        setEvents: (next: DriveEvent[]) => (events = next),
        failIterate: (error: unknown) => (iterateError = error),
    };
}

const created = (eventId: string, nodeUid: string, parentNodeUid: string): DriveEvent => ({
    type: DriveEventType.NodeCreated,
    nodeUid,
    parentNodeUid,
    isTrashed: false,
    isShared: false,
    treeEventScopeId: 'scope-1',
    eventId,
});

describe('EventWatcher', () => {
    test('the last event id is unknown until a poll reads one, then it is the last seen', async () => {
        const s = setup();
        await s.watcher.start();
        expect(s.watcher.lastEventId).toBeUndefined();
        s.setEvents([{ type: DriveEventType.FastForward, treeEventScopeId: 'scope-1', eventId: '5' }, created('6', 'file', 'root')]);
        await s.poll();
        expect(s.watcher.lastEventId).toBe('6');
    });

    test('over restored listings, the first poll reads from the saved event, and drops only what its events name', async () => {
        const folder = { name: 'x', kind: 'folder', size: 0, modified: new Date(0), created: new Date(0), treeEventScopeId: 'scope-1' } as const;
        const restore: ListingSnapshot = {
            rootUid: 'root',
            eventScopeId: 'scope-1',
            lastEventId: '41',
            listings: new Map([
                ['root', [{ ...folder, uid: 'a', name: 'a', parentUid: 'root' }]],
                ['a', []],
                ['b', []],
            ]),
        };
        const s = setup({ restore });
        await s.watcher.start();
        expect(s.watcher.lastEventId).toBe('41');
        s.setEvents([created('42', 'b', 'a')]);
        await s.poll();
        expect(s.calls.iterated).toEqual(['41']);
        const root = await s.tree.root();
        for (const uid of ['root', 'a', 'b']) await s.tree.list({ ...root, uid });
        expect(s.calls.listed).toEqual(['a', 'b']);
    });

    test('a replayed move drops the old parent’s restored listing too, though the event names only the new parent', async () => {
        const folder = { kind: 'folder', size: 0, modified: new Date(0), created: new Date(0), treeEventScopeId: 'scope-1' } as const;
        const restore: ListingSnapshot = {
            rootUid: 'root',
            eventScopeId: 'scope-1',
            lastEventId: '41',
            listings: new Map([
                ['root', [{ ...folder, uid: 'a', name: 'a', parentUid: 'root' }, { ...folder, uid: 'b', name: 'b', parentUid: 'root' }]],
                ['a', [{ ...folder, uid: 'f', name: 'f', parentUid: 'a' }]],
                ['b', []],
                ['c', []],
            ]),
        };
        const s = setup({ restore });
        await s.watcher.start();
        s.setEvents([{ type: DriveEventType.NodeUpdated, nodeUid: 'f', parentNodeUid: 'b', isTrashed: false, isShared: false, treeEventScopeId: 'scope-1', eventId: '42' }]);
        await s.poll();
        const root = await s.tree.root();
        for (const uid of ['root', 'a', 'b', 'c']) await s.tree.list({ ...root, uid });
        expect(s.calls.listed).toEqual(['a', 'b']);
    });

    test('registers the root node’s event scope with the scheduler, listing no folder', async () => {
        const s = setup();
        await s.watcher.start();
        expect(s.calls.scopes).toEqual(['scope-1']);
        expect(s.calls.listed).toEqual([]);
    });

    test('the first poll reads from the latest event, and later polls from the last event seen', async () => {
        const s = setup();
        await s.watcher.start();
        s.setEvents([{ type: DriveEventType.FastForward, treeEventScopeId: 'scope-1', eventId: '5' }]);
        await s.poll();
        s.setEvents([created('6', 'file', 'root')]);
        await s.poll();
        s.setEvents([]);
        await s.poll();
        expect(s.calls.iterated).toEqual([undefined, '5', '6']);
    });

    test('a node event drops the node’s listing and its parent’s, and leaves the others', async () => {
        const s = setup();
        await s.watcher.start();
        const root = await s.tree.root();
        await s.tree.list(root);
        await s.tree.list({ ...root, uid: 'a' });
        await s.tree.list({ ...root, uid: 'b' });
        s.setEvents([created('1', 'a', 'root')]);
        await s.poll();
        await s.tree.list(root);
        await s.tree.list({ ...root, uid: 'a' });
        await s.tree.list({ ...root, uid: 'b' });
        expect(s.calls.listed).toEqual(['root', 'a', 'b', 'root', 'a']);
    });

    test('a deleted node, a tree refresh, a tree removal and a fast-forward each drop what they must', async () => {
        const s = setup();
        await s.watcher.start();
        const root = await s.tree.root();
        const load = async () => {
            for (const uid of ['root', 'a']) await s.tree.list({ ...root, uid });
        };
        await load();
        s.setEvents([{ type: DriveEventType.NodeDeleted, nodeUid: 'a', parentNodeUid: 'root', treeEventScopeId: 'scope-1', eventId: '1' }]);
        await s.poll();
        await load();
        expect(s.calls.listed).toEqual(['root', 'a', 'root', 'a']);
        for (const type of [DriveEventType.TreeRefresh, DriveEventType.TreeRemove, DriveEventType.FastForward] as const) {
            s.calls.listed.length = 0;
            s.setEvents([{ type, treeEventScopeId: 'scope-1', eventId: '9' } as DriveEvent]);
            await s.poll();
            await load();
            expect(s.calls.listed).toEqual(['root', 'a']);
        }
    });

    test('a poll during a rate-limit pause, or without a session, reads no events', async () => {
        let now = 0;
        let problem: string | undefined;
        const s = setup({ now: () => now, authProblem: () => problem });
        await s.watcher.start();
        s.failIterate(new RateLimitedError('slow down'));
        await s.poll();
        expect(s.calls.iterated).toHaveLength(1);
        s.failIterate(undefined);
        await s.poll();
        expect(s.calls.iterated).toHaveLength(1);
        now = 31_000;
        problem = 'signed out';
        await s.poll();
        expect(s.calls.iterated).toHaveLength(1);
        problem = undefined;
        await s.poll();
        expect(s.calls.iterated).toHaveLength(2);
    });

    test('a failed read leaves the last event id, and the poll does not throw', async () => {
        const s = setup();
        await s.watcher.start();
        s.setEvents([created('3', 'a', 'root')]);
        await s.poll();
        s.failIterate(new Error('boom'));
        await s.poll();
        s.failIterate(undefined);
        await s.poll();
        expect(s.calls.iterated).toEqual([undefined, '3', '3']);
    });

    test('a start that fails retries every 60 s until it works', async () => {
        const s = setup({ startFailures: 2 });
        await s.watcher.start();
        expect(s.timers.map((t) => t.ms)).toEqual([START_RETRY_MS]);
        expect(s.calls.scopes).toEqual([]);
        await s.timers[0]!.callback();
        expect(s.timers.map((t) => t.ms)).toEqual([START_RETRY_MS, START_RETRY_MS]);
        await s.timers[1]!.callback();
        expect(s.calls.scopes).toEqual(['scope-1']);
        expect(s.timers).toHaveLength(2);
    });

    test('stop ends the retry', async () => {
        const s = setup({ startFailures: 5 });
        await s.watcher.start();
        s.watcher.stop();
        await s.timers[0]!.callback();
        expect(s.timers).toHaveLength(1);
    });
});
