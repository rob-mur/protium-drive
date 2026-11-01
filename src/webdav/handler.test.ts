import { describe, expect, test } from 'bun:test';

import { DriveError } from '../drive/errors.ts';
import { DriveTree } from '../drive/tree.ts';
import { createWebDavHandler, parseRange } from './handler.ts';
import type { Entry } from '../drive/entry.ts';
import type { ByteRange } from '../drive/download.ts';

const ROOT: Entry = {
    uid: 'root',
    name: 'My files',
    kind: 'folder',
    size: 0,
    modified: new Date('2026-02-01T00:00:00Z'),
    created: new Date('2026-01-01T00:00:00Z'),
    treeEventScopeId: 'volume-1',
};

function fileEntry(name: string, size: number): Entry {
    return {
        uid: `uid-${name}`,
        name,
        kind: 'file',
        size,
        modified: new Date('2026-02-01T00:00:00Z'),
        created: new Date('2026-01-01T00:00:00Z'),
        revisionUid: `rev-${name}`,
        treeEventScopeId: 'volume-1',
    };
}

function treeWithRoot(): DriveTree {
    return {
        root: async () => ROOT,
        list: async () => [],
        stat: async (segments: string[]) => (segments.length === 0 ? ROOT : undefined),
    } as unknown as DriveTree;
}

/** A tree holding files by path; `read` records every download it starts. */
function treeWithFiles(files: Record<string, Entry>, content: (file: Entry, range?: ByteRange) => Uint8Array): DriveTree {
    const downloads: { file: Entry; range?: ByteRange }[] = [];
    const tree = {
        root: async () => ROOT,
        list: async () => [],
        stat: async (segments: string[]) => files[segments.join('/')],
        read: async (file: Entry, range?: ByteRange) => {
            downloads.push({ file, range });
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(content(file, range));
                    controller.close();
                },
            });
        },
    } as unknown as DriveTree & { downloads: typeof downloads };
    tree.downloads = downloads;
    return tree as unknown as DriveTree;
}

function patternBytes(size: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        out[i] = i % 256;
    }
    return out;
}

function serve(tree: DriveTree) {
    const handle = createWebDavHandler({ tree, logger: QUIET });
    return handle;
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
        expect(response.headers.get('Allow')).toBe('OPTIONS, PROPFIND, GET, HEAD');
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
        const response = await handle(new Request('http://127.0.0.1/', { method: 'PUT' }));
        expect(response.status).toBe(405);
        expect(response.headers.get('Allow')).toBe('OPTIONS, PROPFIND, GET, HEAD');
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

describe('GET and HEAD', () => {
    const CONTENT = patternBytes(4096);

    function files(content: Uint8Array, empty = false) {
        return treeWithFiles(
            {
                'Videos/clip.mp4': fileEntry('clip.mp4', content.length),
                'notes/empty.txt': fileEntry('empty.txt', 0),
            },
            (file, range) => {
                if (file.size === 0) {
                    return new Uint8Array();
                }
                const start = range?.start ?? 0;
                const end = (range?.end ?? content.length - 1) + 1;
                return content.subarray(start, empty ? start : end);
            },
        );
    }

    test('GET streams the whole file', async () => {
        const tree = files(CONTENT);
        const response = await serve(tree)(new Request('http://127.0.0.1/Videos/clip.mp4'));
        expect(response.status).toBe(200);
        expect(response.headers.get('Accept-Ranges')).toBe('bytes');
        expect(response.headers.get('Content-Length')).toBe('4096');
        expect(response.headers.get('ETag')).toBe('"rev-clip.mp4"');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(CONTENT);
    });

    test('GET with one exact range answers 206 with exactly those bytes', async () => {
        const tree = files(CONTENT);
        const response = await serve(tree)(
            new Request('http://127.0.0.1/Videos/clip.mp4', { headers: { Range: 'bytes=1000-1099' } }),
        );
        expect(response.status).toBe(206);
        expect(response.headers.get('Content-Range')).toBe('bytes 1000-1099/4096');
        expect(response.headers.get('Content-Length')).toBe('100');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(CONTENT.subarray(1000, 1100));
    });

    test('GET with several ranges, or another unit, serves the full 200 body', async () => {
        const tree = files(CONTENT);
        for (const range of ['bytes=0-99,500-599', 'items=0-99']) {
            const response = await serve(tree)(new Request('http://127.0.0.1/Videos/clip.mp4', { headers: { Range: range } }));
            expect(response.status).toBe(200);
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(CONTENT);
        }
    });

    test('GET with a range outside the file is 416', async () => {
        const tree = files(CONTENT);
        const response = await serve(tree)(new Request('http://127.0.0.1/Videos/clip.mp4', { headers: { Range: 'bytes=5000-' } }));
        expect(response.status).toBe(416);
        expect(response.headers.get('Content-Range')).toBe('bytes */4096');
    });

    test('HEAD answers the GET headers without a download', async () => {
        const tree = files(CONTENT);
        const response = await serve(tree)(new Request('http://127.0.0.1/Videos/clip.mp4', { method: 'HEAD' }));
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Length')).toBe('4096');
        expect((await response.arrayBuffer()).byteLength).toBe(0);
        expect((tree as unknown as { downloads: unknown[] }).downloads).toHaveLength(0);
    });

    test('GET on an empty file serves it without starting a download', async () => {
        const tree = files(CONTENT);
        const response = await serve(tree)(new Request('http://127.0.0.1/notes/empty.txt'));
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Length')).toBe('0');
        expect(await response.text()).toBe('');
        expect((tree as unknown as { downloads: unknown[] }).downloads).toHaveLength(0);
    });

    test('GET on a folder is 405, and on a missing path is 404', async () => {
        const handle = serve(treeWithRoot());
        const folder = await handle(new Request('http://127.0.0.1/'));
        expect(folder.status).toBe(405);
        expect(await folder.text()).toContain('use PROPFIND');
        const missing = await handle(new Request('http://127.0.0.1/nope'));
        expect(missing.status).toBe(404);
    });
});

describe('parseRange', () => {
    test('parses the single-range forms', () => {
        expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
        expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
        expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    });

    test('serves a full body for no range or forms it does not support', () => {
        expect(parseRange(null, 100)).toBeUndefined();
        expect(parseRange('bytes=0-1,5-6', 100)).toBeUndefined();
        expect(parseRange('items=0-1', 100)).toBeUndefined();
    });

    test('reports ranges outside the file', () => {
        expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
        expect(parseRange('bytes=5-4', 100)).toBe('unsatisfiable');
        expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
        expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    });
});
