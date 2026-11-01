import { describe, expect, test } from 'bun:test';

import { DriveError } from '../drive/errors.ts';
import { DriveTree } from '../drive/tree.ts';
import { createWebDavHandler } from './handler.ts';
import type { Entry } from '../drive/entry.ts';

const ROOT: Entry = {
    uid: 'root',
    name: 'My files',
    kind: 'folder',
    size: 0,
    modified: new Date('2026-02-01T00:00:00Z'),
    created: new Date('2026-01-01T00:00:00Z'),
    treeEventScopeId: 'volume-1',
};

function treeWithRoot(): DriveTree {
    return {
        root: async () => ROOT,
        list: async () => [],
        stat: async (segments: string[]) => (segments.length === 0 ? ROOT : undefined),
    } as unknown as DriveTree;
}

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

function handler(tree = treeWithRoot()) {
    const infos: string[] = [];
    const handle = createWebDavHandler({ tree, logger: { ...QUIET, info: (line: string) => infos.push(line) } });
    return { handle, infos };
}

describe('createWebDavHandler', () => {
    test('OPTIONS says what the serve answers and that it is a DAV server', async () => {
        const { handle } = handler();
        const response = await handle(new Request('http://127.0.0.1/', { method: 'OPTIONS' }));
        expect(response.status).toBe(200);
        expect(response.headers.get('DAV')).toBe('1');
        expect(response.headers.get('Allow')).toBe('OPTIONS, PROPFIND');
        expect(response.headers.get('MS-Author-Via')).toBe('DAV');
    });

    test('PROPFIND Depth 1 on the root answers 207 with the root and no children', async () => {
        const { handle } = handler();
        const response = await handle(new Request('http://127.0.0.1/', { method: 'PROPFIND', headers: { Depth: '1' } }));
        const body = await response.text();
        expect(response.status).toBe(207);
        expect(response.headers.get('Content-Type')).toContain('xml');
        expect(body.split('<D:response>').length - 1).toBe(1);
        expect(body).toContain('<D:href>/</D:href>');
    });

    test('PROPFIND Depth 0 lists only the target itself', async () => {
        const { handle } = handler();
        const response = await handle(new Request('http://127.0.0.1/', { method: 'PROPFIND', headers: { Depth: '0' } }));
        expect(response.status).toBe(207);
    });

    test('PROPFIND without a Depth means infinity, and that is refused', async () => {
        const { handle } = handler();
        const response = await handle(new Request('http://127.0.0.1/', { method: 'PROPFIND' }));
        expect(response.status).toBe(403);
        expect(await response.text()).toContain('use Depth: 0 or 1');
    });

    test('PROPFIND on a path that does not exist is 404', async () => {
        const { handle } = handler();
        const response = await handle(new Request('http://127.0.0.1/nope', { method: 'PROPFIND', headers: { Depth: '0' } }));
        expect(response.status).toBe(404);
        expect(await response.text()).toContain('/nope not found');
    });

    test('a method the serve does not answer yet is 405, naming what it does answer', async () => {
        const { handle } = handler();
        const response = await handle(new Request('http://127.0.0.1/', { method: 'GET' }));
        expect(response.status).toBe(405);
        expect(response.headers.get('Allow')).toBe('OPTIONS, PROPFIND');
    });

    test('a bad path segment is 400, and an unexpected error is 500', async () => {
        const { handle } = handler();
        expect((await handle(new Request('http://127.0.0.1/%zz', { method: 'PROPFIND', headers: { Depth: '0' } }))).status).toBe(400);

        const broken = { root: async () => { throw new Error('boom'); }, list: async () => [], stat: async () => undefined } as unknown as DriveTree;
        const failing = createWebDavHandler({ tree: broken, logger: QUIET });
        const response = await failing(new Request('http://127.0.0.1/', { method: 'PROPFIND', headers: { Depth: '0' } }));
        expect(response.status).toBe(500);
        expect(await response.text()).toContain('boom');
    });

    test('every request logs one line with method, path and status', async () => {
        const { handle, infos } = handler();
        await handle(new Request('http://127.0.0.1/', { method: 'OPTIONS' }));
        expect(infos.filter((line) => /^OPTIONS \/ -> \d+ \(\d+ ms\)$/.test(line))).toHaveLength(1);
    });

    test('a DriveError at 500 or above is warned about', async () => {
        const warns: string[] = [];
        const broken = { root: async () => { throw new DriveError(502, 'Proton broke'); }, list: async () => [], stat: async () => undefined } as unknown as DriveTree;
        const handle = createWebDavHandler({ tree: broken, logger: { ...QUIET, warn: (line: string) => warns.push(line) } });
        const response = await handle(new Request('http://127.0.0.1/', { method: 'PROPFIND', headers: { Depth: '0' } }));
        expect(response.status).toBe(502);
        expect(warns.some((line) => line.includes('Proton broke'))).toBeTrue();
    });
});
