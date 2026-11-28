import { describe, expect, test } from 'bun:test';

import {
    AbortError,
    ConnectionError,
    DecryptionError,
    IntegrityError,
    RateLimitedError,
    ServerError,
    NodeWithSameNameExistsValidationError,
    ValidationError,
    NodeType,
    type NodeEntity,
} from '@protontech/drive-sdk';

import { Backoff } from '../drive/backoff.ts';
import { DriveError } from '../drive/errors.ts';
import { DriveTree } from '../drive/tree.ts';
import { createWebDavHandler, LARGE_LISTING, parseRange } from './handler.ts';
import { FailedPutGuard } from './guard.ts';
import { type Entry, toEntry } from '../drive/entry.ts';
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
        expect(response.headers.get('Allow')).toBe('OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE');
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
        const response = await handle(new Request('http://127.0.0.1/', { method: 'COPY' }));
        expect(response.status).toBe(405);
        expect(response.headers.get('Allow')).toBe('OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE');
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

/** A tree whose folders `big` and `other` each hold `count` files. */
function treeWithLargeFolders(count: number): DriveTree {
    const folder = (name: string): Entry => ({ ...ROOT, uid: `uid-${name}`, name });
    const children = Array.from({ length: count }, (_, i) => fileEntry(`f${i}.txt`, i));
    return {
        root: async () => ROOT,
        list: async () => children,
        stat: async (segments: string[]) => (segments.length === 0 ? ROOT : folder(segments[0])),
    } as unknown as DriveTree;
}

const listRequest = (path: string) => new Request(`http://127.0.0.1/${path}/`, { method: 'PROPFIND', headers: { Depth: '1' } });

/** Whether `promise` settles before the tasks queued now have run. */
async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    void promise.then(() => (settled = true), () => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return settled;
}

describe('PROPFIND of a large folder (#183)', () => {
    test('streams the listing in many chunks, not as one body', async () => {
        const handle = serve(treeWithLargeFolders(LARGE_LISTING * 2));
        const response = await handle(listRequest('big'));
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let chunks = 0;
        let body = '';
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
            chunks++;
            body += decoder.decode(read.value, { stream: true });
        }
        expect(response.status).toBe(207);
        expect(chunks).toBeGreaterThan(4);
        expect(body.split('<D:response>').length - 1).toBe(LARGE_LISTING * 2 + 1);
        expect(body).toStartWith('<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:"><D:response><D:href>/big/</D:href>');
        expect(body).toEndWith('</D:response></D:multistatus>\n');
    });

    test('a second large listing of the same folder waits until the first is read to its end', async () => {
        const handle = serve(treeWithLargeFolders(LARGE_LISTING + 1));
        const first = await handle(listRequest('big'));
        const second = await handle(listRequest('big'));
        const firstReader = first.body!.getReader();
        await firstReader.read();

        const secondText = second.text();
        expect(await settlesSoon(secondText)).toBe(false);

        while (!(await firstReader.read()).done) {}
        expect((await secondText).split('<D:response>').length - 1).toBe(LARGE_LISTING + 2);
    });

    test('a cancelled large listing lets the next one of that folder go', async () => {
        const handle = serve(treeWithLargeFolders(LARGE_LISTING + 1));
        const first = await handle(listRequest('big'));
        const second = await handle(listRequest('big'));
        const firstReader = first.body!.getReader();
        await firstReader.read();
        await firstReader.cancel();
        expect(await settlesSoon(second.text())).toBe(true);
    });

    test('a large listing whose client left before reading it lets the next one go', async () => {
        const handle = serve(treeWithLargeFolders(LARGE_LISTING + 1));
        const left = new AbortController();
        await handle(new Request('http://127.0.0.1/big/', { method: 'PROPFIND', headers: { Depth: '1' }, signal: left.signal }));
        const second = await handle(listRequest('big'));
        left.abort();
        expect(await settlesSoon(second.text())).toBe(true);
    });

    test('large listings of different folders, and small listings, do not wait', async () => {
        const handle = serve(treeWithLargeFolders(LARGE_LISTING + 1));
        const first = await handle(listRequest('big'));
        await first.body!.getReader().read();
        expect(await settlesSoon((await handle(listRequest('other'))).text())).toBe(true);

        const small = serve(treeWithLargeFolders(LARGE_LISTING));
        const held = await small(listRequest('big'));
        await held.body!.getReader().read();
        expect(await settlesSoon((await small(listRequest('big'))).text())).toBe(true);
    });
});

describe('auth problem', () => {
    test('an auth problem answers 401 naming it, before any routing or Drive call', async () => {
        const stats: string[][] = [];
        const tree = {
            root: async () => ROOT,
            list: async () => [],
            stat: async (segments: string[]) => {
                stats.push(segments);
                return undefined;
            },
        } as unknown as DriveTree;
        const handle = createWebDavHandler({ tree, logger: QUIET, authProblem: () => 'Proton refused the stored session' });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'PROPFIND', headers: { Depth: '1' } }));
        expect(response.status).toBe(401);
        expect(await response.text()).toContain('Proton refused the stored session');
        // The tree was never reached for the refused session.
        expect(stats).toEqual([]);
    });

    test('OPTIONS still answers while the session is refused', async () => {
        const handle = createWebDavHandler({ tree: treeWithRoot(), logger: QUIET, authProblem: () => 'refused' });
        expect((await handle(new Request('http://127.0.0.1/', { method: 'OPTIONS' }))).status).toBe(200);
    });

    test('an auth problem turns a mid-request failure into 401 rather than 500', async () => {
        const broken = { root: async () => { throw new Error('boom'); }, list: async () => [], stat: async () => undefined } as unknown as DriveTree;
        const handle = createWebDavHandler({ tree: broken, logger: QUIET, authProblem: () => 'Proton refused the stored session' });
        const response = await handle(new Request('http://127.0.0.1/', { method: 'PROPFIND', headers: { Depth: '0' } }));
        expect(response.status).toBe(401);
        expect(await response.text()).toContain('Proton refused the stored session');
    });

    test('no auth problem means requests route as usual', async () => {
        const handle = createWebDavHandler({ tree: treeWithRoot(), logger: QUIET, authProblem: () => undefined });
        expect((await handle(new Request('http://127.0.0.1/', { method: 'PROPFIND', headers: { Depth: '0' } }))).status).toBe(207);
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

    test('a Drive media type that is not a media type is served as application/octet-stream', async () => {
        const node = {
            uid: 'uid-inject.txt',
            parentUid: 'root',
            type: NodeType.File,
            name: { ok: true, value: 'inject.txt' },
            mediaType: 'text/plain\r\nX: y',
            creationTime: new Date('2026-01-01T00:00:00Z'),
            modificationTime: new Date('2026-02-01T00:00:00Z'),
            activeRevision: { uid: 'rev-inject', claimedSize: 3 },
            treeEventScopeId: 'volume-1',
        } as unknown as NodeEntity;
        const entry = toEntry(node) as Entry;
        const tree = treeWithFiles({ 'inject.txt': entry }, () => new Uint8Array([1, 2, 3]));
        const response = await serve(tree)(new Request('http://127.0.0.1/inject.txt'));
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    });
});

describe('PUT', () => {
    /** A tree that records every upload with the body it was handed. */
    function treeWithUploads(existing: Record<string, Entry> = {}) {
        const uploads: { segments: string[]; name: string; body: string; options: unknown }[] = [];
        const tree = {
            root: async () => ROOT,
            list: async () => [],
            stat: async (segments: string[]) => existing[segments.join('/')],
            upload: async (
                segments: string[],
                name: string,
                body: ReadableStream<Uint8Array>,
                options: { size?: number; mediaType: string; modified?: Date },
            ) => {
                uploads.push({ segments, name, body: await new Response(body).text(), options });
                const parent = existing[segments.join('/')] ?? ROOT;
                const entry: Entry = {
                    uid: `new-${name}`,
                    name,
                    kind: 'file',
                    size: options.size ?? 0,
                    modified: options.modified ?? new Date('2026-02-01T00:00:00Z'),
                    created: new Date('2026-01-01T00:00:00Z'),
                    revisionUid: 'new-rev',
                    treeEventScopeId: 'volume-1',
                };
                return { entry, created: !existing[`${segments.join('/')}/${name}`] };
            },
        } as unknown as DriveTree & { uploads: typeof uploads };
        tree.uploads = uploads;
        return tree as unknown as DriveTree & { uploads: typeof uploads };
    }

    function put(path: string, init: RequestInit = {}) {
        const tree = treeWithUploads({ Photos: { ...ROOT, uid: 'photos', name: 'Photos' } });
        const handle = createWebDavHandler({ tree, logger: QUIET });
        return { tree, response: handle(new Request(`http://127.0.0.1${path}`, { method: 'PUT', ...init })) };
    }

    test('a new name is 201, and the tree gets the size, media type and mtime', async () => {
        const { tree, response: pending } = put('/Photos/beach.jpg', {
            headers: { 'Content-Length': '12', 'Content-Type': 'image/jpeg', 'X-OC-Mtime': '1770000000' },
            body: 'sand and sea',
        });
        const response = await pending;
        expect(response.status).toBe(201);
        const upload = tree.uploads[0]!;
        expect(upload.segments).toEqual(['Photos']);
        expect(upload.name).toBe('beach.jpg');
        expect(upload.body).toBe('sand and sea');
        expect(upload.options).toEqual({
            size: 12,
            mediaType: 'image/jpeg',
            modified: new Date(1770000000 * 1000),
        });
    });

    test('an existing name is 204 with a new revision', async () => {
        const photos: Entry = { ...ROOT, uid: 'photos', name: 'Photos' };
        const tree = treeWithUploads({
            Photos: photos,
            'Photos/beach.jpg': fileEntry('beach.jpg', 12),
        });
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(
            new Request('http://127.0.0.1/Photos/beach.jpg', {
                method: 'PUT',
                headers: { 'Content-Length': '12' },
                body: 'sand and snow',
            }),
        );
        expect(response.status).toBe(204);
        expect(tree.uploads[0]?.body).toBe('sand and snow');
    });

    test('a missing Content-Type means application/octet-stream', async () => {
        const { tree, response: pending } = put('/Photos/beach.jpg', {
            headers: { 'Content-Length': '12' },
            body: 'sand and sea',
        });
        await pending;
        expect(tree.uploads[0]?.options).toMatchObject({ mediaType: 'application/octet-stream' });
    });

    test('PUT to the root folder is 405', async () => {
        const { response: pending } = put('/', { headers: { 'Content-Length': '0' }, body: '' });
        expect((await pending).status).toBe(405);
    });

    test('a bad Content-Length is 400', async () => {
        const { response: pending } = put('/Photos/beach.jpg', {
            headers: { 'Content-Length': '-1' },
            body: 'sand and sea',
        });
        const response = await pending;
        expect(response.status).toBe(400);
        expect(await response.text()).toContain('Bad Content-Length');
    });

    test('a missing body is never an empty file unless the client said 0 bytes', async () => {
        const tree = treeWithUploads({ Photos: { ...ROOT, uid: 'photos', name: 'Photos' } });
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const noBody = await handle(
            new Request('http://127.0.0.1/Photos/beach.jpg', { method: 'PUT', headers: { 'Content-Length': '12' } }),
        );
        expect(noBody.status).toBe(400);
        const noLength = await handle(new Request('http://127.0.0.1/Photos/beach.jpg', { method: 'PUT' }));
        expect(noLength.status).toBe(400);
        expect(await noLength.text()).toContain('no body and no Content-Length');
        expect(tree.uploads).toEqual([]);
    });

    test('an explicit 0 bytes uploads an empty file', async () => {
        const { tree, response: pending } = put('/Photos/empty.txt', {
            headers: { 'Content-Length': '0' },
        });
        const response = await pending;
        expect(response.status).toBe(201);
        expect(tree.uploads).toHaveLength(1);
        expect(tree.uploads[0]?.body).toBe('');
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

describe('DELETE', () => {
    /** A tree that records every trash call, refusing what the entries list holds. */
    function treeWithTrashes(existing: Record<string, Entry>, refused: string[] = []) {
        const trashed: string[] = [];
        const tree = {
            root: async () => ROOT,
            list: async () => [],
            stat: async (segments: string[]) => existing[segments.join('/')],
            trash: async (segments: string[]) => {
                const path = segments.join('/');
                if (refused.includes(path)) {
                    throw new DriveError(403, 'The root folder cannot be deleted');
                }
                if (!existing[path]) {
                    throw new DriveError(404, `/${path} not found`);
                }
                trashed.push(path);
            },
        } as unknown as DriveTree & { trashed: string[] };
        tree.trashed = trashed;
        return tree as unknown as DriveTree & { trashed: string[] };
    }

    test('DELETE on a file trashes it and answers 204 with no body', async () => {
        const tree = treeWithTrashes({ 'Photos/beach.jpg': fileEntry('beach.jpg', 12) });
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos/beach.jpg', { method: 'DELETE' }));
        expect(response.status).toBe(204);
        expect((await response.arrayBuffer()).byteLength).toBe(0);
        expect(tree.trashed).toEqual(['Photos/beach.jpg']);
    });

    test('DELETE on the root is 403, and nothing reaches the Drive', async () => {
        const tree = treeWithTrashes({}, ['']);
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/', { method: 'DELETE' }));
        expect(response.status).toBe(403);
        expect(await response.text()).toContain('The root folder cannot be deleted');
        expect(tree.trashed).toEqual([]);
    });

    test('DELETE on a missing path is 404', async () => {
        const tree = treeWithTrashes({});
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos/missing.jpg', { method: 'DELETE' }));
        expect(response.status).toBe(404);
        expect(await response.text()).toContain('/Photos/missing.jpg not found');
    });

    test('DELETE within the window after a failed overwrite is 423, and nothing reaches the Drive', async () => {
        const beach = fileEntry('beach.jpg', 12);
        const tree = treeWithTrashes({ 'Photos/beach.jpg': beach });
        tree.upload = async () => {
            throw new Error('upload part-way failure');
        };
        const guard = new FailedPutGuard(60_000, () => 0);
        const warnings: string[] = [];
        const handle = createWebDavHandler({ tree, logger: { ...QUIET, warn: (line: string) => warnings.push(line) }, guard });
        await handle(
            new Request('http://127.0.0.1/Photos/beach.jpg', { method: 'PUT', headers: { 'Content-Length': '12' }, body: 'sand and snow' }),
        );
        const response = await handle(new Request('http://127.0.0.1/Photos/beach.jpg', { method: 'DELETE' }));
        expect(response.status).toBe(423);
        expect(await response.text()).toContain('protected after a failed overwrite');
        expect(tree.trashed).toEqual([]);
        expect(warnings.join('\n')).toContain('refused for a while');
    });

    test('DELETE after the guard window passes trashes the file', async () => {
        const tree = treeWithTrashes({ 'Photos/beach.jpg': fileEntry('beach.jpg', 12) });
        tree.upload = async () => {
            throw new Error('upload part-way failure');
        };
        let now = 0;
        const guard = new FailedPutGuard(60_000, () => now);
        const handle = createWebDavHandler({ tree, logger: QUIET, guard });
        await handle(
            new Request('http://127.0.0.1/Photos/beach.jpg', { method: 'PUT', headers: { 'Content-Length': '12' }, body: 'sand and snow' }),
        );
        now = 61_000;
        const response = await handle(new Request('http://127.0.0.1/Photos/beach.jpg', { method: 'DELETE' }));
        expect(response.status).toBe(204);
        expect(tree.trashed).toEqual(['Photos/beach.jpg']);
    });

    test('a successful PUT after a failed one lifts the guard at once', async () => {
        const tree = treeWithTrashes({ 'Photos/beach.jpg': fileEntry('beach.jpg', 12) });
        let fail = true;
        tree.upload = async () => {
            if (fail) throw new Error('upload part-way failure');
            return { entry: fileEntry('beach.jpg', 13), created: false };
        };
        const guard = new FailedPutGuard(60_000, () => 0);
        const handle = createWebDavHandler({ tree, logger: QUIET, guard });
        await handle(
            new Request('http://127.0.0.1/Photos/beach.jpg', { method: 'PUT', headers: { 'Content-Length': '13' }, body: 'sand and snow' }),
        );
        fail = false;
        const good = await handle(
            new Request('http://127.0.0.1/Photos/beach.jpg', { method: 'PUT', headers: { 'Content-Length': '13' }, body: 'sand and sun' }),
        );
        expect(good.status).toBe(204);
        const response = await handle(new Request('http://127.0.0.1/Photos/beach.jpg', { method: 'DELETE' }));
        expect(response.status).toBe(204);
        expect(tree.trashed).toEqual(['Photos/beach.jpg']);
    });

    test('a failed PUT of a new name does not guard the DELETE of that name', async () => {
        const tree = treeWithTrashes({});
        tree.upload = async () => {
            throw new Error('upload part-way failure');
        };
        const guard = new FailedPutGuard(60_000, () => 0);
        const handle = createWebDavHandler({ tree, logger: QUIET, guard });
        await handle(
            new Request('http://127.0.0.1/Photos/new.jpg', { method: 'PUT', headers: { 'Content-Length': '3' }, body: 'abc' }),
        );
        const response = await handle(new Request('http://127.0.0.1/Photos/new.jpg', { method: 'DELETE' }));
        expect(response.status).toBe(404);
    });
});

describe('MKCOL', () => {
    /** A tree that records every createFolder call, refusing what the entries list holds. */
    function treeWithFolders(existing: Record<string, Entry>, refused: string[] = []) {
        const created: string[] = [];
        const tree = {
            root: async () => ROOT,
            list: async () => [],
            stat: async (segments: string[]) => existing[segments.join('/')],
            createFolder: async (parentSegments: string[], name: string) => {
                const parent = parentSegments.join('/');
                if (refused.includes(parent)) {
                    throw new DriveError(409, `/${parent} is not a folder`);
                }
                const path = parent ? `${parent}/${name}` : name;
                if (existing[path]) {
                    throw new DriveError(405, `${name} already exists`);
                }
                created.push(path);
                return { uid: `uid-${name}`, name, kind: 'folder' } as Entry;
            },
        } as unknown as DriveTree & { created: string[] };
        tree.created = created;
        return tree as unknown as DriveTree & { created: string[] };
    }

    test('MKCOL under an existing folder creates it and answers 201 with no body', async () => {
        const tree = treeWithFolders({ Photos: { uid: 'photos', name: 'Photos', kind: 'folder' } as Entry });
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos/2025', { method: 'MKCOL' }));
        expect(response.status).toBe(201);
        expect((await response.arrayBuffer()).byteLength).toBe(0);
        expect(tree.created).toEqual(['Photos/2025']);
    });

    test('MKCOL of a name that already exists is 405, and nothing is created', async () => {
        const tree = treeWithFolders({
            Photos: { uid: 'photos', name: 'Photos', kind: 'folder' } as Entry,
            'Photos/2025': fileEntry('2025', 1),
        });
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos/2025', { method: 'MKCOL' }));
        expect(response.status).toBe(405);
        expect(await response.text()).toContain('already exists');
        expect(tree.created).toEqual([]);
    });

    test('MKCOL with a body is 415, and nothing is created', async () => {
        const tree = treeWithFolders({});
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'MKCOL', body: 'noise' }));
        expect(response.status).toBe(415);
        expect(await response.text()).toContain('MKCOL carries a body');
        expect(tree.created).toEqual([]);
    });

    test('MKCOL on the root is 405, and nothing is created', async () => {
        const tree = treeWithFolders({});
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/', { method: 'MKCOL' }));
        expect(response.status).toBe(405);
        expect(await response.text()).toContain('root folder already exists');
        expect(tree.created).toEqual([]);
    });

    test('MKCOL under a path that is not a folder is 409', async () => {
        const tree = treeWithFolders({ 'Photos/beach.jpg': fileEntry('beach.jpg', 12) }, ['Photos/beach.jpg']);
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos/beach.jpg/2025', { method: 'MKCOL' }));
        expect(response.status).toBe(409);
        expect(await response.text()).toContain('is not a folder');
    });
});

describe('rate limit', () => {
    test('a rate-limited call is 503 with Retry-After at the seconds left', async () => {
        const backoff = new Backoff(() => 0);
        backoff.note(new RateLimitedError('slow down'));
        const tree = {
            root: async () => ROOT,
            list: async () => [],
            stat: async () => {
                throw new RateLimitedError('slow down');
            },
            backoff,
        } as unknown as DriveTree;
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'PROPFIND', headers: { Depth: '1' } }));
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('30');
        expect(await response.text()).toContain('rate limit');
    });
});

describe('MOVE', () => {
    /** A tree that records every move call with what it was handed. */
    function treeWithMoves(existing: Record<string, Entry> = {}, options: { overwrite: boolean } = { overwrite: true }) {
        const moves: { from: string[]; to: string[]; overwrite: boolean; result: 'created' | 'not-created' }[] = [];
        const tree = {
            root: async () => ROOT,
            list: async () => [],
            stat: async (segments: string[]) => existing[segments.join('/')],
            move: async (from: string[], to: string[], overwrite: boolean) => {
                const entry = existing[to.join('/')];
                if (entry && !overwrite) {
                    throw new DriveError(412, `${to[to.length - 1]} already exists`);
                }
                const result: 'created' | 'not-created' = entry ? 'not-created' : 'created';
                moves.push({ from, to, overwrite, result });
                return {
                    entry: { ...(entry ?? fileEntry(options.overwrite ? to[to.length - 1] : from[from.length - 1], 12)), uid: from[from.length - 1] === to[to.length - 1] && from.length === 1 ? 'uid-source' : 'uid-moved' },
                    created: result === 'created',
                };
            },
        } as unknown as DriveTree & { moves: typeof moves };
        tree.moves = moves;
        return tree as unknown as DriveTree & { moves: typeof moves };
    }

    function moveRequest(from: string, to: string, opts: { overwrite?: boolean } = {}) {
        const url = `http://127.0.0.1${from}`;
        const headers: HeadersInit = {
            Destination: `http://127.0.0.1${to}`,
            Overwrite: opts.overwrite === false ? 'F' : 'T',
        };
        return new Request(url, { method: 'MOVE', headers });
    }

    test('MOVE needs a Destination header', async () => {
        const tree = treeWithMoves();
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/beach.jpg', { method: 'MOVE' }));
        expect(response.status).toBe(400);
        expect(await response.text()).toContain('needs a Destination header');
    });

    test('MOVE to another host is 502', async () => {
        const tree = treeWithMoves();
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/beach.jpg', {
            method: 'MOVE',
            headers: {
                Destination: 'http://other.host/beach.jpg',
                Overwrite: 'T',
            },
        }));
        expect(response.status).toBe(502);
        expect(await response.text()).toContain('another server');
    });

    test('MOVE without Overwrite header defaults to T (overwrite)', async () => {
        const tree = treeWithMoves({ 'Photos/beach.jpg': fileEntry('beach.jpg', 12) });
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(moveRequest('/beach.jpg', '/Photos/beach.jpg'));
        expect(tree.moves[0]?.overwrite).toBe(true);
    });

    test('MOVE with Overwrite: F refuses existing target', async () => {
        const tree = treeWithMoves({ 'Photos/beach.jpg': fileEntry('beach.jpg', 12) });
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/beach.jpg', {
            method: 'MOVE',
            headers: {
                Destination: 'http://127.0.0.1/Photos/beach.jpg',
                Overwrite: 'F',
            },
        }));
        expect(response.status).toBe(412);
        expect(await response.text()).toContain('already exists');
        expect(tree.moves).toEqual([]);
    });

    test('MOVE to new location returns 201 (created)', async () => {
        const tree = treeWithMoves();
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(moveRequest('/beach.jpg', '/Photos/beach.jpg'));
        expect(response.status).toBe(201);
        expect(tree.moves).toHaveLength(1);
        expect(tree.moves[0]?.result).toBe('created');
    });

    test('MOVE overwriting existing file returns 204 (not created)', async () => {
        const tree = treeWithMoves({ 'Photos/beach.jpg': fileEntry('beach.jpg', 12) });
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(moveRequest('/beach.jpg', '/Photos/beach.jpg'));
        expect(response.status).toBe(204);
        expect(tree.moves[0]?.result).toBe('not-created');
    });
});

describe('error mapping', () => {
    function treeWithError(error: Error): DriveTree {
        return {
            root: async () => ROOT,
            list: async () => [],
            stat: async () => {
                throw error;
            },
        } as unknown as DriveTree;
    }

    test('AbortError maps to 499', async () => {
        const tree = treeWithError(new AbortError('Client closed the connection'));
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'PROPFIND', headers: { Depth: '1' } }));
        expect(response.status).toBe(499);
        expect(await response.text()).toContain('Client closed the connection');
    });

    test('ConnectionError maps to 503', async () => {
        const tree = treeWithError(new ConnectionError('Network unavailable'));
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'PROPFIND', headers: { Depth: '1' } }));
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('10');
        expect(await response.text()).toContain('Connection error');
    });

    test('DecryptionError maps to 500', async () => {
        const tree = treeWithError(new DecryptionError('Decryption failed'));
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'PROPFIND', headers: { Depth: '1' } }));
        expect(response.status).toBe(500);
        expect(await response.text()).toContain('Decryption error');
    });

    test('IntegrityError maps to 502', async () => {
        const tree = treeWithError(new IntegrityError('Hash mismatch'));
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'PROPFIND', headers: { Depth: '1' } }));
        expect(response.status).toBe(502);
        expect(await response.text()).toContain('Integrity error');
    });

    test('ValidationError maps to 400', async () => {
        const tree = treeWithError(new ValidationError('Invalid name', 1001));
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'PROPFIND', headers: { Depth: '1' } }));
        expect(response.status).toBe(400);
        expect(await response.text()).toContain('Invalid name');
    });

    test('ServerError with statusCode uses that status', async () => {
        const error = Object.assign(new ServerError('Forbidden'), { statusCode: 403 });
        const tree = treeWithError(error);
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'PROPFIND', headers: { Depth: '1' } }));
        expect(response.status).toBe(403);
        expect(await response.text()).toContain('Forbidden');
    });

    test('ServerError without statusCode is 502', async () => {
        const error = new ServerError('Internal error');
        // statusCode not set
        const tree = treeWithError(error);
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'PROPFIND', headers: { Depth: '1' } }));
        expect(response.status).toBe(502);
        expect(await response.text()).toContain('Internal error');
    });

    test('ServerError with a 500 statusCode is 502', async () => {
        const tree = treeWithError(Object.assign(new ServerError('Internal server error'), { statusCode: 500 }));
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'PROPFIND', headers: { Depth: '1' } }));
        expect(response.status).toBe(502);
    });

    test('a name clash maps to 409', async () => {
        const tree = treeWithError(new NodeWithSameNameExistsValidationError('Name taken', 2500, undefined, false));
        const handle = createWebDavHandler({ tree, logger: QUIET });
        const response = await handle(new Request('http://127.0.0.1/Photos', { method: 'PROPFIND', headers: { Depth: '1' } }));
        expect(response.status).toBe(409);
        expect(await response.text()).toContain('Name taken');
    });
});
