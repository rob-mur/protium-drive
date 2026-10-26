import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeDrive, FakeDriveClient } from './drive.ts';
import { StateFile } from './state-file.ts';

type Items = { format: 1; items: string[] };

let dir: string;
let path: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-drive-state-'));
    path = join(dir, 'items.json');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const open = () => new StateFile<Items>(path, () => ({ format: 1, items: [] }));
const saved = () => (JSON.parse(readFileSync(path, 'utf8')) as Items).items;

describe('a state file shared by two processes', () => {
    test('a change applies to the latest state, so no change of the other process is lost', () => {
        const first = open();
        const second = open();
        first.change((state) => void state.items.push('first'));
        second.change((state) => void state.items.push('second'));
        expect(saved()).toEqual(['first', 'second']);
        expect(first.read().items).toEqual(['first', 'second']);
    });

    test('a change through a file opened on existing state keeps each edit, a read during the change included', () => {
        open().change((state) => void state.items.push('before'));
        const reopened = open();
        reopened.change((state) => {
            state.items.push('one');
            reopened.read();
            state.items.push('two');
        });
        expect(saved()).toEqual(['before', 'one', 'two']);
    });

    test('a move through a Drive reopened on the same DIR holds', async () => {
        const drive = FakeDrive.open(dir);
        drive.add('a.txt', { type: 'file', content: new TextEncoder().encode('a') });
        drive.add('Dest', { type: 'folder' });
        const reopened = FakeDrive.open(dir);
        const client = new FakeDriveClient(reopened);
        for await (const result of client.moveNodes([reopened.nodeAt('a.txt').uid], reopened.nodeAt('Dest').uid)) expect(result.ok).toBe(true);
        expect(reopened.nodeAt('Dest/a.txt').uid).toBe(drive.nodeAt('Dest/a.txt').uid);
    });
});
