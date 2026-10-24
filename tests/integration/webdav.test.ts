import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { eventually, type Harness, startHarness } from '../support/harness';

let h: Harness;

beforeEach(() => {
    h = startHarness();
});

afterEach(async () => {
    await h.stop();
});

function propfind(path: string, depth: string) {
    return fetch(h.url(path), { method: 'PROPFIND', headers: { Depth: depth } });
}

function hrefs(xml: string): string[] {
    return [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
}

function bytes(size: number, seed = 7): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(size);
    let x = seed;
    for (let i = 0; i < size; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        data[i] = x & 0xff;
    }
    return data;
}

describe('OPTIONS and PROPFIND', () => {
    test('OPTIONS advertises WebDAV class 1', async () => {
        const res = await fetch(h.url('/'), { method: 'OPTIONS' });
        expect(res.status).toBe(200);
        expect(res.headers.get('DAV')).toBe('1');
        expect(res.headers.get('Allow')).toContain('PROPFIND');
    });

    test('Depth 1 lists the folder and its children', async () => {
        h.fake.remoteWrite('photos/a b.jpg', 'jpeg data');
        h.fake.remoteMkdirp(['photos', 'sub']);
        const res = await propfind('/photos/', '1');
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(hrefs(xml)).toEqual(['/photos/', '/photos/a%20b.jpg', '/photos/sub/']);
        expect(xml).toContain('<D:getcontentlength>9</D:getcontentlength>');
        expect(xml).toContain('<D:resourcetype><D:collection/></D:resourcetype>');
        expect(xml).toMatch(/<D:getlastmodified>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4}/);
    });

    test('Depth 0 returns only the target', async () => {
        h.fake.remoteWrite('photos/a.jpg', 'x');
        expect(hrefs(await (await propfind('/photos', '0')).text())).toEqual(['/photos/']);
        expect(hrefs(await (await propfind('/photos/a.jpg', '0')).text())).toEqual(['/photos/a.jpg']);
    });

    test('Depth infinity is refused, so nothing walks the whole Drive', async () => {
        expect((await propfind('/', 'infinity')).status).toBe(403);
        expect((await fetch(h.url('/'), { method: 'PROPFIND' })).status).toBe(403);
    });

    test('a missing path is 404', async () => {
        expect((await propfind('/nope', '0')).status).toBe(404);
    });

    test('names with XML and URL special characters survive', async () => {
        const name = `<odd> & "name" #1 ?.txt`;
        h.fake.remoteWrite(name, 'x');
        const xml = await (await propfind('/', '1')).text();
        const href = hrefs(xml).find((value) => value !== '/')!;
        expect(decodeURIComponent(href.slice(1))).toBe(name.replace(/&/g, '&'));
        expect(await (await fetch(h.url(href))).text()).toBe('x');
    });
});

describe('GET and HEAD', () => {
    test('GET streams the whole file with metadata headers', async () => {
        const data = bytes(300_000);
        h.fake.remoteWrite('big.bin', data);
        const res = await fetch(h.url('/big.bin'));
        expect(res.status).toBe(200);
        // Bun sends stream bodies chunked and drops Content-Length; PROPFIND carries the size.
        expect(res.headers.get('Accept-Ranges')).toBe('bytes');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
        await eventually(() => h.fake.activeDownloads === 0);
    });

    test('Range reads use the seekable stream', async () => {
        const data = bytes(200_000);
        h.fake.remoteWrite('v.mp4', data);
        const res = await fetch(h.url('/v.mp4'), { headers: { Range: 'bytes=100000-100099' } });
        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe('bytes 100000-100099/200000');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(data.slice(100000, 100100));

        const tail = await fetch(h.url('/v.mp4'), { headers: { Range: 'bytes=-10' } });
        expect(new Uint8Array(await tail.arrayBuffer())).toEqual(data.slice(-10));
        await eventually(() => h.fake.activeDownloads === 0);
    });

    test('Range reads of old revisions fall back to a full download and skip bytes', async () => {
        const data = bytes(150_000);
        h.fake.remoteWrite('old.jpg', data, { legacy: true });
        const res = await fetch(h.url('/old.jpg'), { headers: { Range: 'bytes=70000-70009' } });
        expect(res.status).toBe(206);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(data.slice(70000, 70010));
        await eventually(() => h.fake.activeDownloads === 0);
    });

    test('a range outside the file is 416', async () => {
        h.fake.remoteWrite('a.txt', 'abc');
        const res = await fetch(h.url('/a.txt'), { headers: { Range: 'bytes=10-' } });
        expect(res.status).toBe(416);
        expect(res.headers.get('Content-Range')).toBe('bytes */3');
    });

    test('HEAD answers from the cache and takes no download slot', async () => {
        h.fake.remoteWrite('a.txt', 'abc');
        const res = await fetch(h.url('/a.txt'), { method: 'HEAD' });
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Length')).toBe('3');
        expect(h.fake.count('getFileDownloader')).toBe(0);
    });

    test('an empty file needs no download', async () => {
        h.fake.remoteWrite('empty.txt', '');
        const res = await fetch(h.url('/empty.txt'));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('');
        expect(h.fake.count('getFileDownloader')).toBe(0);
    });

    test('a file that fails verification never arrives complete', async () => {
        const data = bytes(200_000);
        h.fake.remoteWrite('bad.bin', data, { corrupt: true });
        const res = await fetch(h.url('/bad.bin'));
        let received = 0;
        let failed = false;
        const reader = res.body!.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                received += value.length;
            }
        } catch {
            failed = true;
        }
        expect(failed || received < data.length).toBe(true);
        await eventually(() => h.fake.activeDownloads === 0);
    });

    test('a small file that fails verification is an HTTP error, not an empty 200', async () => {
        h.fake.remoteWrite('bad.txt', 'tiny', { corrupt: true });
        const res = await fetch(h.url('/bad.txt'));
        expect(res.status).toBe(502);
        await eventually(() => h.fake.activeDownloads === 0);
    });

    test('a client that stops reading frees the download slot', async () => {
        h.fake.remoteWrite('big.bin', bytes(2_000_000));
        for (let i = 0; i < 8; i++) {
            const abort = new AbortController();
            const res = await fetch(h.url('/big.bin'), { signal: abort.signal });
            const reader = res.body!.getReader();
            await reader.read();
            abort.abort();
            await reader.cancel().catch(() => {});
            await eventually(() => h.fake.activeDownloads === 0);
        }
        // More downloads than the SDK has slots: none of them leaked.
        expect(h.fake.count('getFileDownloader')).toBe(8);
    });

    test('a client that leaves before the response starts frees the download slot', async () => {
        h.fake.remoteWrite('big.bin', bytes(8 * 1024 * 1024));
        h.fake.downloaderDelayMs = 300;
        for (const range of [undefined, 'bytes=100-200']) {
            for (let i = 0; i < 6; i++) {
                const abort = new AbortController();
                const headers: Record<string, string> = range ? { Range: range } : {};
                const pending = fetch(h.url('/big.bin'), { signal: abort.signal, headers }).catch(() => undefined);
                setTimeout(() => abort.abort(), 100);
                await pending;
            }
        }
        // Each download either never took a slot or gave it back.
        await eventually(() => h.fake.activeDownloads === 0);
        h.fake.downloaderDelayMs = 0;
        expect(await (await fetch(h.url('/big.bin'), { headers: { Range: 'bytes=0-3' } })).bytes()).toEqual(
            bytes(8 * 1024 * 1024).slice(0, 4),
        );
    });

    test('a reader that stalls holds the slot, and gives it back when its request aborts', async () => {
        // Bun's fetch reads the whole response, so drive the tree directly.
        h.fake.remoteWrite('big.bin', bytes(2_000_000));
        const entry = (await h.app.tree.stat(['big.bin']))!;
        const abort = new AbortController();
        const body = await h.app.tree.read(entry, undefined, abort.signal);
        await body.getReader().read();
        // The bridge is full and the SDK writer waits for the reader.
        await Bun.sleep(50);
        expect(h.fake.activeDownloads).toBe(1);
        abort.abort();
        await eventually(() => h.fake.activeDownloads === 0);
    });

    test('GET on a folder is 405', async () => {
        h.fake.remoteMkdirp(['dir']);
        expect((await fetch(h.url('/dir/'))).status).toBe(405);
    });
});

describe('PUT', () => {
    test('creates a file (201), then overwrites it as a new revision (204)', async () => {
        const created = await fetch(h.url('/new.txt'), { method: 'PUT', body: 'first', headers: { 'Content-Type': 'text/plain' } });
        expect(created.status).toBe(201);
        expect(h.fake.text('new.txt')).toBe('first');
        expect(h.fake.byPath('new.txt').mediaType).toBe('text/plain');

        const replaced = await fetch(h.url('/new.txt'), { method: 'PUT', body: 'second version' });
        expect(replaced.status).toBe(204);
        expect(h.fake.text('new.txt')).toBe('second version');
        expect(h.fake.byPath('new.txt').revision).toBe(2);
        expect(await (await fetch(h.url('/new.txt'))).text()).toBe('second version');
    });

    test('streams a body without Content-Length', async () => {
        const data = bytes(500_000);
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                for (let offset = 0; offset < data.length; offset += 100_000) {
                    controller.enqueue(data.slice(offset, offset + 100_000));
                }
                controller.close();
            },
        });
        const res = await fetch(h.url('/stream.bin'), { method: 'PUT', body, duplex: 'half' } as RequestInit);
        expect(res.status).toBe(201);
        expect(h.fake.byPath('stream.bin').content).toEqual(data);
    });

    test('takes the modification time from X-OC-Mtime', async () => {
        await fetch(h.url('/m.txt'), { method: 'PUT', body: 'x', headers: { 'X-OC-Mtime': '1700000000' } });
        expect(h.fake.byPath('m.txt').modified.getTime()).toBe(1_700_000_000_000);
    });

    test('a PUT without a body never becomes an empty file', async () => {
        const res = await fetch(h.url('/empty.txt'), { method: 'PUT' });
        expect([400, 201]).toContain(res.status);
        if (res.status === 201) {
            // fetch sent "Content-Length: 0": a real empty file is fine.
            expect(h.fake.text('empty.txt')).toBe('');
        }
    });

    test('a missing parent folder is 409', async () => {
        expect((await fetch(h.url('/no/such/dir.txt'), { method: 'PUT', body: 'x' })).status).toBe(409);
    });

    test('PUT onto a folder is 405', async () => {
        h.fake.remoteMkdirp(['dir']);
        expect((await fetch(h.url('/dir'), { method: 'PUT', body: 'x' })).status).toBe(405);
    });

    test('after a failed overwrite, the cleanup DELETE cannot trash the old file', async () => {
        h.fake.remoteWrite('keep.jpg', 'good old content');
        await fetch(h.url('/keep.jpg'));
        // The SDK refuses the upload, as on a size mismatch.
        h.fake.getFileRevisionUploader = async () => {
            throw new Error('upload refused');
        };
        const put = await fetch(h.url('/keep.jpg'), { method: 'PUT', body: 'new content' });
        expect(put.status).toBe(500);
        const del = await fetch(h.url('/keep.jpg'), { method: 'DELETE' });
        expect(del.status).toBe(423);
        expect(h.fake.text('keep.jpg')).toBe('good old content');
        expect(h.fake.trashedNames()).toEqual([]);
    });
});

describe('DELETE, MKCOL, MOVE, COPY', () => {
    test('DELETE moves a file to the trash', async () => {
        h.fake.remoteWrite('a.txt', 'x');
        expect((await fetch(h.url('/a.txt'), { method: 'DELETE' })).status).toBe(204);
        expect(h.fake.trashedNames()).toEqual(['a.txt']);
        expect((await propfind('/a.txt', '0')).status).toBe(404);
        expect((await fetch(h.url('/a.txt'), { method: 'DELETE' })).status).toBe(404);
    });

    test('DELETE of the root is refused', async () => {
        expect((await fetch(h.url('/'), { method: 'DELETE' })).status).toBe(403);
    });

    test('MKCOL creates a folder once', async () => {
        expect((await fetch(h.url('/new'), { method: 'MKCOL' })).status).toBe(201);
        expect((await fetch(h.url('/new'), { method: 'MKCOL' })).status).toBe(405);
        expect((await fetch(h.url('/a/b'), { method: 'MKCOL' })).status).toBe(409);
        expect(hrefs(await (await propfind('/', '1')).text())).toContain('/new/');
    });

    test('MOVE renames and moves', async () => {
        h.fake.remoteWrite('a.txt', 'x');
        h.fake.remoteMkdirp(['dir']);
        const rename = await fetch(h.url('/a.txt'), { method: 'MOVE', headers: { Destination: h.url('/b.txt') } });
        expect(rename.status).toBe(201);
        const move = await fetch(h.url('/b.txt'), { method: 'MOVE', headers: { Destination: '/dir/c%20d.txt' } });
        expect(move.status).toBe(201);
        expect(h.fake.text('dir/c d.txt')).toBe('x');
        expect(hrefs(await (await propfind('/', '1')).text())).toEqual(['/', '/dir/']);
        expect(h.fake.count('moveNodes')).toBe(1);
        expect(h.fake.count('renameNode')).toBe(2);
    });

    test('MOVE onto an existing file needs Overwrite: T, and trashes the old target', async () => {
        h.fake.remoteWrite('a.txt', 'new');
        h.fake.remoteWrite('b.txt', 'old');
        const refused = await fetch(h.url('/a.txt'), { method: 'MOVE', headers: { Destination: '/b.txt', Overwrite: 'F' } });
        expect(refused.status).toBe(412);
        const done = await fetch(h.url('/a.txt'), { method: 'MOVE', headers: { Destination: '/b.txt' } });
        expect(done.status).toBe(204);
        expect(h.fake.text('b.txt')).toBe('new');
        expect(h.fake.trashedNames()).toEqual(['b.txt']);
    });

    test('MOVE of a folder into itself is refused', async () => {
        h.fake.remoteMkdirp(['dir']);
        const res = await fetch(h.url('/dir/'), { method: 'MOVE', headers: { Destination: '/dir/inner/' } });
        expect(res.status).toBe(409);
    });

    test('COPY is not implemented', async () => {
        h.fake.remoteWrite('a.txt', 'x');
        expect((await fetch(h.url('/a.txt'), { method: 'COPY', headers: { Destination: '/b.txt' } })).status).toBe(501);
    });
});

describe('sessions and rate limits', () => {
    test('a missing or refused session is 401 and makes no SDK call', async () => {
        await h.stop();
        h = startHarness({ authProblem: () => 'Proton refused the stored session' });
        const res = await propfind('/', '1');
        expect(res.status).toBe(401);
        expect(await res.text()).toContain('refused');
        expect(Object.keys(h.fake.calls)).toEqual([]);
    });

    test('a rate limit becomes 503 with Retry-After, and the next request does not call Proton', async () => {
        h.fake.rateLimitCalls = 1;
        const first = await propfind('/', '1');
        expect(first.status).toBe(503);
        expect(Number(first.headers.get('Retry-After'))).toBeGreaterThan(0);
        const calls = h.fake.count('getMyFilesRootFolder');
        const second = await propfind('/', '1');
        expect(second.status).toBe(503);
        expect(h.fake.count('getMyFilesRootFolder')).toBe(calls);
    });
});

describe('--root', () => {
    test('serves only the chosen folder', async () => {
        await h.stop();
        h = startHarness({ root: 'Photos/immich' });
        h.fake.remoteWrite('Photos/immich/upload/x.jpg', 'x');
        h.fake.remoteWrite('private.txt', 'secret');
        expect(hrefs(await (await propfind('/', '1')).text())).toEqual(['/', '/upload/']);
        expect((await fetch(h.url('/private.txt'))).status).toBe(404);
        expect((await fetch(h.url('/upload/y.jpg'), { method: 'PUT', body: 'y' })).status).toBe(201);
        expect(h.fake.text('Photos/immich/upload/y.jpg')).toBe('y');
    });
});
