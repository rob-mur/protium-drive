import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm as rmAsync } from 'node:fs/promises';

import { afterEach, describe, expect, test } from 'bun:test';

import { authLogin } from './auth/login.ts';
import { createLogger } from './logger.ts';
import { serveCommand, NOT_SIGNED_IN, LOOPBACK_WARNING } from './serve.ts';

const DIRS: string[] = [];
const QUIET = createLogger({ PDM_LOG_LEVEL: 'error' });

function scratch(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `pdm-serve-${label}-XXXXXX`));
    DIRS.push(dir);
    return dir;
}

afterEach(async () => {
    while (DIRS.length) {
        const dir = DIRS.pop()!;
        await rmAsync(dir, { recursive: true, force: true }).catch(() => {});
    }
});

/** Signs in against the fake drive, as the user approves the sign-in in a browser. Returns the control channel. */
async function signIn(stateDir: string, driveDir: string): Promise<URL> {
    let controlUrl: URL | undefined;
    const urlSeen = new Promise<void>((resolve) => {
        authLogin({
            stateDir,
            logger: QUIET,
            fakeDriveDir: driveDir,
            print: (line) => {
                if (/^https:\/\/\S+$/.test(line.trim())) resolve();
            },
            onControlUrl: (url) => {
                controlUrl = url;
            },
        }).then((code) => {
            expect(code).toBe(0);
        });
    });
    await urlSeen;
    await fetch(new URL('account/approve', controlUrl!), { method: 'POST' });
    return controlUrl!;
}

describe('serveCommand', () => {
    test('refuses to start without a session, naming auth login, and exits 1', async () => {
        const stateDir = scratch('empty');
        const driveDir = scratch('drive');
        const errors: string[] = [];
        const logger = { ...QUIET, error: (line: string) => errors.push(line) };

        const code = await serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir });

        expect(code).toBe(1);
        expect(errors).toEqual([NOT_SIGNED_IN]);
    });

    test('serves an empty Drive: the root listing is empty', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        await signIn(stateDir, driveDir);
        const abort = new AbortController();
        const lines: string[] = [];
        const logger = { ...QUIET, info: (line: string) => lines.push(line) };
        const serving = serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        const servingLine = await waitFor(lines, 'Serving Proton Drive');
        const url = servingLine!.match(/https?:\/\/\S+/)![0];

        const propfind = await fetch(url, { method: 'PROPFIND', headers: { Depth: '1' } });
        const body = await propfind.text();
        abort.abort();
        expect(await serving).toBe(0);

        expect(propfind.status).toBe(207);
        expect(body).toContain('<D:multistatus');
        // The root is there; it has no children to list.
        expect(body).toContain('resourcetype><D:collection');
        expect(body.split('<D:response>').length - 1).toBe(1);
    });

    test('logs one line per request to stderr, level via PDM_LOG_LEVEL', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        await signIn(stateDir, driveDir);
        const abort = new AbortController();
        const infos: string[] = [];
        const logger = { ...QUIET, info: (line: string) => infos.push(line) };
        const serving = serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        const servingLine = await waitFor(infos, 'Serving Proton Drive');
        await fetch(servingLine!.match(/https?:\/\/\S+/)![0], { method: 'OPTIONS' });
        await fetch(`${servingLine!.match(/https?:\/\/\S+/)![0]}nope`, { method: 'PROPFIND', headers: { Depth: '0' } });
        abort.abort();
        await serving;

        const requestLines = infos.filter((line) => line.includes('->'));
        expect(requestLines.some((line) => line.startsWith('OPTIONS / -> 200'))).toBeTrue();
        expect(requestLines.some((line) => line.startsWith('PROPFIND /nope -> 404'))).toBeTrue();
    });

    test('warns when the host is not loopback: no authentication of its own', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        await signIn(stateDir, driveDir);
        const abort = new AbortController();
        const warns: string[] = [];
        const logger = { ...QUIET, warn: (line: string) => warns.push(line) };
        const serving = serveCommand({ stateDir, host: '0.0.0.0', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        await waitFor(warns, 'anyone who can reach it');
        abort.abort();
        expect(await serving).toBe(0);
        expect(warns).toContain(LOOPBACK_WARNING('0.0.0.0'));
    });

    test('never warns for the loopback hosts', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        await signIn(stateDir, driveDir);
        const abort = new AbortController();
        const warns: string[] = [];
        const infos: string[] = [];
        const logger = { ...QUIET, warn: (line: string) => warns.push(line), info: (line: string) => infos.push(line) };
        const serving = serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        await waitFor(infos, 'Serving Proton Drive');
        abort.abort();
        expect(await serving).toBe(0);
        expect(warns).toEqual([]);
    });

    test('PUT writes a new file with one revision, its media type, and its size declared first', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        const controlUrl = await signIn(stateDir, driveDir);
        await fetch(new URL('add', controlUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: '/Photos', type: 'folder' }),
        });
        const abort = new AbortController();
        const infos: string[] = [];
        const logger = { ...QUIET, info: (line: string) => infos.push(line) };
        const serving = serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        const url = (await waitFor(infos, 'Serving Proton Drive'))!.match(/https?:\/\/\S+/)![0];

        const put = await fetch(new URL('Photos/beach.jpg', url), {
            method: 'PUT',
            headers: { 'Content-Length': '12', 'Content-Type': 'image/jpeg' },
            body: 'sand and sea',
        });
        abort.abort();
        await serving;

        expect(put.status).toBe(201);
        const beach = driveNode(driveDir, 'beach.jpg');
        expect(beach.revisions).toHaveLength(1);
        expect(beach.revisions[0].mediaType).toBe('image/jpeg');
        expect(beach.revisions[0].declaredSize).toBe(12);
        const content = readFileSync(join(driveDir, 'blobs', beach.revisions[0].blob));
        expect(content.toString()).toBe('sand and sea');
    });

    test('PUT over an existing file adds a revision and keeps the old content', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        const controlUrl = await signIn(stateDir, driveDir);
        await fetch(new URL('add', controlUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: '/Photos/beach.jpg', type: 'file', contentBase64: btoa('sand and sea') }),
        });
        const abort = new AbortController();
        const infos: string[] = [];
        const logger = { ...QUIET, info: (line: string) => infos.push(line) };
        const serving = serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        const url = (await waitFor(infos, 'Serving Proton Drive'))!.match(/https?:\/\/\S+/)![0];

        const put = await fetch(new URL('Photos/beach.jpg', url), {
            method: 'PUT',
            headers: { 'Content-Length': '12' },
            body: 'sand and snow',
        });
        abort.abort();
        await serving;

        expect(put.status).toBe(204);
        const beach = driveNode(driveDir, 'beach.jpg');
        expect(beach.revisions).toHaveLength(2);
        const old = readFileSync(join(driveDir, 'blobs', beach.revisions[0].blob));
        expect(old.toString()).toBe('sand and sea');
        const now = readFileSync(join(driveDir, 'blobs', beach.revisions[1].blob));
        expect(now.toString()).toBe('sand and snow');
    });

    test('a write tells the Drive its size before it sends the bytes', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        const controlUrl = await signIn(stateDir, driveDir);
        await fetch(new URL('add', controlUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: '/Photos', type: 'folder' }),
        });
        const abort = new AbortController();
        const infos: string[] = [];
        const logger = { ...QUIET, info: (line: string) => infos.push(line) };
        const serving = serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        const url = (await waitFor(infos, 'Serving Proton Drive'))!.match(/https?:\/\/\S+/)![0];

        await fetch(new URL('Photos/beach.jpg', url), {
            method: 'PUT',
            headers: { 'Content-Length': '12' },
            body: 'sand and sea',
        });
        abort.abort();
        await serving;

        const beach = driveNode(driveDir, 'beach.jpg');
        expect(beach.revisions[0].declaredSize).toBe(12);
    });

    test('a second serve on one state directory is refused, naming the first pid', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        await signIn(stateDir, driveDir);
        const abort = new AbortController();
        const infos: string[] = [];
        const logger = { ...QUIET, info: (line: string) => infos.push(line) };
        const first = serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        await waitFor(infos, 'Serving Proton Drive');

        let secondError: unknown;
        try {
            await serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger: QUIET, fakeDriveDir: scratch('other') });
        } catch (error: unknown) {
            secondError = error;
        }
        abort.abort();
        expect(await first).toBe(0);
        expect(String(secondError)).toContain(`pid ${process.pid}`);
        expect(String(secondError)).toContain(stateDir);
    });
});

/** The node named `name` in the fake drive's persisted state, for looking at it from the outside. */
function driveNode(driveDir: string, name: string): { revisions: { blob: string; declaredSize: number | null; mediaType: string }[] } {
    const state = JSON.parse(readFileSync(join(driveDir, 'drive.json'), 'utf8')) as {
        nodes: Record<string, { name: string; revisions: { blob: string; declaredSize: number | null; mediaType: string }[] }>;
    };
    const found = Object.values(state.nodes).find((node) => node.name === name);
    expect(found).toBeDefined();
    return found!;
}

async function waitFor(lines: string[], part: string): Promise<string | undefined> {
    for (let i = 0; i < 500; i++) {
        const line = lines.find((l) => l.includes(part));
        if (line !== undefined) {
            return line;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
}
