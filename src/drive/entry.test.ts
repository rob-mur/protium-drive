import { describe, expect, test } from 'bun:test';
import { NodeType } from '@protontech/drive-sdk';

import { toEntry, isSkipped } from './entry.ts';
import type { NodeEntity } from '@protontech/drive-sdk';

function node(overrides: Record<string, unknown> = {}): NodeEntity {
    return {
        uid: 'node-1',
        parentUid: 'parent-1',
        type: NodeType.Folder,
        name: { ok: true, value: 'Documents' },
        creationTime: new Date('2026-01-01T00:00:00Z'),
        modificationTime: new Date('2026-02-01T00:00:00Z'),
        trashTime: undefined,
        treeEventScopeId: 'volume-1',
        ...overrides,
    } as unknown as NodeEntity;
}

describe('toEntry', () => {
    test('a folder keeps its name and times, with no size', () => {
        const entry = toEntry(node());
        expect(entry).toMatchObject({ kind: 'folder', name: 'Documents', size: 0, parentUid: 'parent-1' });
        expect(isSkipped(entry)).toBeFalse();
    });

    test('a file takes its size, modification time and etag revision from its active revision', () => {
        const entry = toEntry(
            node({
                type: NodeType.File,
                mediaType: 'text/plain',
                activeRevision: {
                    uid: 'revision-1',
                    claimedSize: 12,
                    claimedModificationTime: new Date('2026-03-01T00:00:00Z'),
                    claimedDigests: { sha1: 'abc' },
                },
            }) as NodeEntity,
        );
        expect(entry).toMatchObject({
            kind: 'file',
            size: 12,
            revisionUid: 'revision-1',
            sha1: 'abc',
            mediaType: 'text/plain',
            modified: new Date('2026-03-01T00:00:00Z'),
        });
    });

    test('a file carries its armored node key; a folder and a file without one carry none', () => {
        const file = { type: NodeType.File, activeRevision: { uid: 'r', claimedSize: 1 } };
        expect(toEntry(node({ ...file, encryptedCrypto: { armoredKey: 'ARMOR' } }))).toMatchObject({ armoredNodeKey: 'ARMOR' });
        expect(toEntry(node(file))).not.toHaveProperty('armoredNodeKey', 'ARMOR');
        expect(toEntry(node({ encryptedCrypto: { armoredKey: 'ARMOR' } }))).not.toHaveProperty('armoredNodeKey');
    });

    test('a file without a claimed size is skipped: it would copy as empty', () => {
        const entry = toEntry(node({ type: NodeType.File, activeRevision: { uid: 'r' } }) as NodeEntity);
        expect(isSkipped(entry)).toBeTrue();
    });

    test('a trashed node, an undecryptable name and an unknown type are skipped', () => {
        expect(isSkipped(toEntry(node({ trashTime: new Date() })))).toBeTrue();
        expect(isSkipped(toEntry(node({ name: { ok: false, value: undefined, error: new Error('x') } }) as NodeEntity))).toBeTrue();
        expect(isSkipped(toEntry(node({ type: NodeType.Album }) as NodeEntity))).toBeTrue();
    });
});
