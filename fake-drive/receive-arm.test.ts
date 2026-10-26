import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConnectionError } from '@protontech/drive-sdk';

import type { SessionCredentials, SessionInfo } from '../vendor/proton-drive-sdk-account/sessionCredentials.ts';
import { CONTROL_LINE, type ReceiveArm, startReceiveArm } from './receive-arm.ts';

let base: string;
let dir: string;
const running: ReceiveArm[] = [];

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'receive-arm-'));
    dir = join(base, 'drive');
});

afterEach(async () => {
    for (const arm of running.splice(0)) await arm.stop();
    rmSync(base, { recursive: true, force: true });
});

async function start(): Promise<{ arm: ReceiveArm; printed: string[] }> {
    const printed: string[] = [];
    const arm = await startReceiveArm(dir, { print: (line) => printed.push(line) });
    running.push(arm);
    return { arm, printed };
}

async function upload(arm: ReceiveArm, parent: string, name: string, content: string): Promise<string> {
    const uploader = await arm.client.getFileUploader(parent, name, { mediaType: 'text/plain', expectedSize: content.length });
    return (await (await uploader.uploadFromStream(new Blob([content]).stream(), [])).completion()).nodeUid;
}

describe('the Receive arm', () => {
    test('starts on an empty DIR and prints the URL of its control channel', async () => {
        const { arm, printed } = await start();
        expect(arm.controlUrl.hostname).toBe('127.0.0.1');
        expect(printed).toEqual([`fake-drive: control channel at ${arm.controlUrl.href}`]);
        expect(printed[0]).toMatch(CONTROL_LINE);
        expect(printed[0]!.match(CONTROL_LINE)![1]).toBe(arm.controlUrl.href);

        const root = await arm.client.getMyFilesRootFolder();
        await upload(arm, root.uid, 'a.txt', 'hello');
        expect(await (await fetch(new URL('/content?path=a.txt', arm.controlUrl))).text()).toBe('hello');
    });

    test('started again on the same DIR, it serves the same Drive', async () => {
        const first = (await start()).arm;
        const root = await first.client.getMyFilesRootFolder();
        const folder = await first.client.createFolder(root, 'Docs');
        const uid = await upload(first, folder.uid, 'a.txt', 'one');
        const revisionUploader = await first.client.getFileRevisionUploader(uid, { mediaType: 'text/plain', expectedSize: 3 });
        await (await revisionUploader.uploadFromStream(new Blob(['two']).stream(), [])).completion();
        const gone = await upload(first, root.uid, 'gone.txt', 'x');
        for await (const _ of first.client.trashNodes([gone])) void _;
        const read = async (arm: ReceiveArm, path: string) => (await fetch(new URL(path, arm.controlUrl))).json();
        const before = [await read(first, '/node?path=Docs/a.txt'), await read(first, '/revisions?path=Docs/a.txt'), await read(first, '/trash')];

        await first.stop();
        await expect(fetch(new URL('/trash', first.controlUrl))).rejects.toThrow();

        const second = (await start()).arm;
        expect((await second.client.getMyFilesRootFolder()).uid).toBe(root.uid);
        expect([await read(second, '/node?path=Docs/a.txt'), await read(second, '/revisions?path=Docs/a.txt'), await read(second, '/trash')]).toEqual(
            before,
        );
    });

    test('moves its clock, raises its faults and runs its account through the control channel', async () => {
        const { arm } = await start();
        const post = async (path: string, body?: unknown) => {
            const response = await fetch(new URL(path, arm.controlUrl), { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
            expect(response.status).toBe(200);
            return response.json();
        };

        const start0 = arm.clock.now();
        const fired: number[] = [];
        arm.clock.setTimeout(() => fired.push(arm.clock.now()), 30_000);
        expect(await post('/clock/advance', { seconds: 30 })).toEqual({ now: start0 + 30_000, fired: 1 });
        expect(fired).toEqual([start0 + 30_000]);

        await post('/faults', { kind: 'unreachable', operation: 'getMyFilesRootFolder', path: '' });
        await expect(arm.client.getMyFilesRootFolder()).rejects.toBeInstanceOf(ConnectionError);
        await arm.client.getMyFilesRootFolder();

        const credentials = new SavedCredentials();
        const { auth } = await arm.account.initAccount({ authClientId: 'external-drive', credentials });
        const urls: string[] = [];
        const signedIn = auth.authViaWeb((url) => void urls.push(url));
        while (urls.length === 0) await Bun.sleep(1);
        expect(await post('/account/approve')).toEqual({ approved: 1 });
        await signedIn;
        await post('/account/expire');
        await arm.client.getMyFilesRootFolder();
        expect(credentials.saved?.refreshToken).toBe('refresh-2');
    });

    test('a session saved by one start is accepted by the next start on the same DIR', async () => {
        const first = (await start()).arm;
        const credentials = new SavedCredentials();
        const { auth } = await first.account.initAccount({ authClientId: 'external-drive', credentials });
        let approval: Promise<Response> | undefined;
        await auth.authViaWeb(() => {
            approval = fetch(new URL('/account/approve', first.controlUrl), { method: 'POST' });
        });
        expect((await approval!).status).toBe(200);
        await first.stop();

        const second = (await start()).arm;
        const again = new SavedCredentials(credentials.saved);
        const { auth: auth2 } = await second.account.initAccount({ authClientId: 'external-drive', credentials: again });
        expect(auth2.isLoggedIn()).toBe(true);
        await second.client.getMyFilesRootFolder();
        await fetch(new URL('/account/expire', second.controlUrl), { method: 'POST' });
        await second.client.getMyFilesRootFolder();
        const report = await (await fetch(new URL('/account', second.controlUrl))).json();
        expect(report).toMatchObject({ signIns: { approved: 1 }, refreshes: [{ used: 'refresh-1', outcome: 'rotated' }] });
        expect(again.saved?.refreshToken).toBe('refresh-2');
    });

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        test(`runs on its own from the command line until ${signal} stops it`, async () => {
            const child = Bun.spawn(['bun', join(import.meta.dir, 'receive-arm.ts'), dir], { stderr: 'pipe', stdout: 'ignore' });
            try {
                const reader = child.stderr.getReader();
                let printed = '';
                while (!CONTROL_LINE.test(printed)) {
                    const { value, done } = await reader.read();
                    if (done) throw new Error(`the Receive arm exited before it printed its URL: ${printed}`);
                    printed += new TextDecoder().decode(value);
                }
                const url = new URL(printed.match(CONTROL_LINE)![1]!);
                expect(await (await fetch(new URL('/trash', url))).json()).toEqual([]);
                child.kill(signal);
                expect(await child.exited).toBe(0);
            } finally {
                child.kill();
            }
        });
    }

    test('on its own with no DIR, it prints its usage and exits 2', async () => {
        const child = Bun.spawn(['bun', join(import.meta.dir, 'receive-arm.ts')], { stderr: 'pipe', stdout: 'ignore' });
        try {
            expect(await child.exited).toBe(2);
            expect(await new Response(child.stderr).text()).toContain('usage: bun fake-drive/receive-arm.ts DIR');
        } finally {
            child.kill();
        }
    });
});

/** The product's session code in small: `saved` is what its session file would hold. */
class SavedCredentials implements SessionCredentials {
    private keyPassword?: string;
    private info?: SessionInfo;

    constructor(public saved?: SessionInfo) {}

    get uid() {
        return this.info?.uid;
    }
    get accessToken() {
        return this.info?.accessToken;
    }
    get refreshToken() {
        return this.info?.refreshToken;
    }
    on() {}
    isLoggedIn() {
        return !!this.keyPassword && !!this.info;
    }
    isTelemetryEnabled() {
        return false;
    }
    getUserKeyPassword() {
        return this.keyPassword;
    }
    async load() {
        if (!this.saved) return;
        this.info = this.saved;
        this.keyPassword = 'loaded';
    }
    async setUserKeyPassword(value: string) {
        this.keyPassword = value;
    }
    async setSessionInfo(info: SessionInfo) {
        this.info = info;
        this.saved = info;
    }
    async setTelemetryEnabled() {}
    async signOut() {
        this.info = undefined;
        this.keyPassword = undefined;
    }
}
