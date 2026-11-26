import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CryptoProxy } from '@protontech/crypto';

import { FakeDrive, FakeDriveClient, SCOPE_ID } from './drive.ts';
import { mapConcurrently } from './real-crypto.ts';

let dir: string;
let client: FakeDriveClient;
let drive: FakeDrive;

/** Opens a Drive in a new `DIR` whose `drive.json` asks for real crypto, as a seed writes it. */
function openWithRealCrypto(): void {
    dir = mkdtempSync(join(tmpdir(), 'fake-drive-real-crypto-'));
    const now = new Date().toISOString();
    const rootUid = `${SCOPE_ID}~link-1`;
    const state = {
        format: 1,
        rootUid,
        nextId: 2,
        nextEventId: 1,
        nodes: { [rootUid]: { uid: rootUid, name: 'root', type: 'folder', created: now, modified: now, revisions: [] } },
        events: [],
        realCrypto: true,
    };
    writeFileSync(join(dir, 'drive.json'), JSON.stringify(state));
    drive = FakeDrive.open(dir);
    client = new FakeDriveClient(drive);
}

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

async function list(folder: string): Promise<string[]> {
    const uids: string[] = [];
    for await (const uid of client.iterateFolderChildrenNodeUids(drive.nodeAt(folder).uid)) uids.push(uid);
    const names: string[] = [];
    for await (const node of client.iterateNodes(uids)) {
        if ('missingUid' in node) throw new Error(`missing ${node.missingUid}`);
        names.push(node.name.ok ? node.name.value : '?');
    }
    return names.sort();
}

describe('a Drive with real crypto', () => {
    beforeEach(openWithRealCrypto);

    afterEach(async () => {
        await client.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    test('a listing unlocks each file node key once, and a download of a listed file unlocks none again', async () => {
        drive.add('Album/a.txt', { type: 'file', content: bytes('a'), nodeKey: 'argon2' });
        drive.add('Album/b.txt', { type: 'file', content: bytes('b'), nodeKey: 'v4' });
        const imports = spyOn(CryptoProxy, 'importPrivateKey');
        try {
            expect(await list('Album')).toEqual(['a.txt', 'b.txt']);
            expect(imports).toHaveBeenCalledTimes(2);

            await client.getNode(drive.nodeAt('Album/a.txt').uid);
            await client.getFileDownloader(drive.nodeAt('Album/a.txt').uid);
            expect(imports).toHaveBeenCalledTimes(2);
        } finally {
            imports.mockRestore();
        }
    });

    test('a download gives the content it decrypted, by stream and by seekable stream', async () => {
        const content = bytes('x'.repeat(200 * 1024));
        const uid = drive.add('a.bin', { type: 'file', content, nodeKey: 'argon2' });
        const decrypts = spyOn(CryptoProxy, 'decryptMessage');
        try {
            const chunks: Uint8Array[] = [];
            const writable = new WritableStream<Uint8Array>({ write: (chunk) => void chunks.push(chunk) });
            await (await client.getFileDownloader(uid)).downloadToStream(writable).completion();
            expect(Buffer.concat(chunks).equals(Buffer.from(content))).toBe(true);

            const seekable = (await client.getFileDownloader(uid)).getSeekableStream();
            seekable.seek(100);
            expect(text((await seekable.read(4)).value)).toBe('xxxx');
            expect(decrypts).toHaveBeenCalledTimes(2);
        } finally {
            decrypts.mockRestore();
        }
    });
});

describe('a Drive without real crypto', () => {
    test('does no crypto', async () => {
        dir = mkdtempSync(join(tmpdir(), 'fake-drive-real-crypto-'));
        drive = FakeDrive.open(dir);
        client = new FakeDriveClient(drive);
        const imports = spyOn(CryptoProxy, 'importPrivateKey');
        try {
            const uid = drive.add('a.txt', { type: 'file', content: bytes('a'), nodeKey: 'argon2' });
            expect(await list('')).toEqual(['a.txt']);
            await client.getFileDownloader(uid);
            expect(imports).not.toHaveBeenCalled();
        } finally {
            imports.mockRestore();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('mapConcurrently', () => {
    test('runs at most the limit at once, and yields each result as it ends', async () => {
        let running = 0;
        let most = 0;
        const delays = [30, 5, 20, 1, 10];
        const results: number[] = [];
        for await (const result of mapConcurrently(delays, 2, async (ms) => {
            most = Math.max(most, ++running);
            await new Promise((resolve) => setTimeout(resolve, ms));
            running--;
            return ms;
        })) {
            results.push(result);
        }
        expect(most).toBe(2);
        expect(results.sort((a, b) => a - b)).toEqual([1, 5, 10, 20, 30]);
        expect(results.length).toBe(5);
    });

    test('ends with the error of a call that fails', async () => {
        const run = async () => {
            for await (const _ of mapConcurrently([1, 2, 3], 2, async (n) => {
                if (n === 2) throw new Error('two');
                return n;
            })) void _;
        };
        await expect(run()).rejects.toThrow('two');
    });
});
