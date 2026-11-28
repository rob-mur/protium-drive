import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { authLogin } from '../auth/login.ts';
import { createLogger } from '../logger.ts';
import { startReceiveArm } from '../../fake-drive/receive-arm.ts';

/** Files in the folder the test lists. */
const FILES = 50_000;
/** Listings of that folder sent at once. */
const AT_ONCE = 4;
/**
 * The most the serve's peak resident memory may rise above its warm level while it answers
 * AT_ONCE listings. Before #183 the rise was about 130 MB here: each listing built its whole XML
 * body in memory. Streamed, it is a few MB; the limit leaves room for the garbage collector.
 */
const BUDGET_MB = 48;

const QUIET = createLogger('error');
const DIRS: string[] = [];
let serve: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | undefined;
let base = '';

function scratch(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `pdm-listing-memory-${label}-`));
    DIRS.push(dir);
    return dir;
}

/** Signs in against the fake drive, as the user approves the sign-in in a browser. */
async function signIn(stateDir: string, driveDir: string): Promise<void> {
    let controlUrl: URL | undefined;
    let signedIn!: Promise<number>;
    await new Promise<void>((resolve) => {
        signedIn = authLogin({
            stateDir,
            logger: QUIET,
            fakeDriveDir: driveDir,
            print: (line) => {
                if (/^https:\/\/\S+$/.test(line.trim())) resolve();
            },
            onControlUrl: (url) => {
                controlUrl = url;
            },
        });
    });
    await fetch(new URL('account/approve', controlUrl!), { method: 'POST' });
    expect(await signedIn).toBe(0);
}

/**
 * Puts FILES files into `big/`. One goes in through the control channel; the rest are copies of
 * it written straight into `drive.json`, as an add per file would rewrite the file each time.
 */
async function seedBigFolder(driveDir: string): Promise<void> {
    const arm = await startReceiveArm(driveDir, { print: () => {} });
    try {
        const response = await fetch(new URL('add', arm.controlUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'big/IMG_00000.jpg', type: 'file', content: 'x', mediaType: 'image/jpeg' }),
        });
        expect(response.status).toBe(200);
    } finally {
        await arm.stop();
    }
    const path = join(driveDir, 'drive.json');
    type Node = { uid: string; name: string; revisions: { uid: string }[] };
    const state = JSON.parse(readFileSync(path, 'utf8')) as { nodes: Record<string, Node> };
    const seed = Object.values(state.nodes).find((node) => node.name === 'IMG_00000.jpg')!;
    for (let i = 1; i < FILES; i++) {
        const uid = `bulk-${i}`;
        state.nodes[uid] = {
            ...structuredClone(seed),
            uid,
            name: `IMG_${String(i).padStart(5, '0')}.jpg`,
            revisions: seed.revisions.map((revision) => ({ ...revision, uid: `${uid}-rev` })),
        };
    }
    writeFileSync(path, JSON.stringify(state));
}

/** The serve's resident memory now and at its peak, in MB, from `/proc`. */
function memory(pid: number): { rss: number; peak: number } {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const mb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(status)![1]) / 1024;
    return { rss: mb('VmRSS'), peak: mb('VmHWM') };
}

/** Lists `big/` and checks that the whole listing came back. */
async function listBigFolder(): Promise<void> {
    const response = await fetch(`${base}/big/`, { method: 'PROPFIND', headers: { Depth: '1' } });
    expect(response.status).toBe(207);
    const body = await response.text();
    expect(body.split('<D:response>').length - 1).toBe(FILES + 1);
    expect(body.endsWith('</D:multistatus>\n')).toBe(true);
}

beforeAll(async () => {
    const stateDir = scratch('state');
    const driveDir = scratch('drive');
    await signIn(stateDir, driveDir);
    await seedBigFolder(driveDir);
    // Its own process, so that its memory is the serve's alone.
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    serve = Bun.spawn(
        [process.execPath, join(import.meta.dir, '../main.ts'), 'serve', '--state-dir', stateDir, '--fake-drive', driveDir, '--port', String(port), '--log-level', 'error'],
        { stdout: 'ignore', stderr: 'pipe' },
    );
    base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
        const up = await fetch(base, { method: 'OPTIONS' }).then((r) => r.ok, () => false);
        if (up) break;
        if (attempt > 200) throw new Error(`serve did not start: ${await new Response(serve.stderr).text()}`);
        await Bun.sleep(50);
    }
}, 60_000);

afterAll(async () => {
    serve?.kill();
    await serve?.exited;
    while (DIRS.length) await rm(DIRS.pop()!, { recursive: true, force: true });
});

describe('PROPFIND of a large folder on the fake drive', () => {
    test(`${AT_ONCE} listings of ${FILES} entries at once stay within ${BUDGET_MB} MB above the warm serve`, async () => {
        const pid = serve!.pid;
        // The first listing loads the folder into the tree's listing cache, which is kept by design.
        await listBigFolder();
        await listBigFolder();
        const warm = memory(pid).rss;
        // Writing 5 to clear_refs resets the peak (VmHWM) to the resident memory now.
        writeFileSync(`/proc/${pid}/clear_refs`, '5');

        await Promise.all(Array.from({ length: AT_ONCE }, listBigFolder));

        const rise = memory(pid).peak - warm;
        expect(rise).toBeLessThan(BUDGET_MB);
    }, 60_000);
});
