/**
 * The Receive arm's faults: each one aims at one SDK operation and one target, and each is
 * consumed by the next call that matches it. The control channel sets them (`POST /faults`).
 * They live in memory, in the process whose control channel set them.
 *
 * - `operation` is a method of the SDK surface (`SdkSurface`), for example
 *   `iterateFolderChildrenNodeUids` for a listing.
 * - `path` is the target: `/`-separated names from My files, as on the control channel, and
 *   `""` for My files itself. A call matches when it acts on the node at that path at the time of
 *   the call. `createFolder` and `getFileUploader` act on the parent folder and on the new path, so
 *   either one matches. `getMyFilesRootFolder`, `getEventScheduler` and `iterateEvents` act on My
 *   files. A generator method meets its fault when the product starts to iterate it.
 *
 * The kinds, as the SDK raises them:
 * - `rate-limited`: `RateLimitedError`, what the SDK throws once its own 429 retries give up.
 * - `server-error`: `ServerError` with `statusCode` 500.
 * - `unreachable`: `ConnectionError`.
 * - `integrity` (`getFileDownloader` only): the download fails with `IntegrityError` before its
 *   first byte.
 * - `name-clash` (`getFileUploader` only): `NodeWithSameNameExistsValidationError`.
 * - `upload-part-way` (`getFileUploader`, `getFileRevisionUploader`): the upload reads part of
 *   the content, then fails with `ConnectionError`. The Drive keeps no part of it.
 */
import { ConnectionError, IntegrityError, NodeWithSameNameExistsValidationError, RateLimitedError, ServerError } from '@protontech/drive-sdk';

import { NAME_TAKEN, type SdkSurface } from './drive.ts';

export const FAULT_KINDS = ['rate-limited', 'server-error', 'unreachable', 'integrity', 'name-clash', 'upload-part-way'] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];
export type Operation = keyof SdkSurface;

export type Fault = { kind: FaultKind; operation: Operation; path: string };

/** A fault the Receive arm cannot set. */
export class FaultError extends Error {
    override name = 'FaultError';
}

const OPERATIONS: readonly Operation[] = [
    'getMyFilesRootFolder',
    'iterateFolderChildrenNodeUids',
    'iterateNodes',
    'getNode',
    'createFolder',
    'getFileUploader',
    'getFileRevisionUploader',
    'getFileDownloader',
    'trashNodes',
    'renameNode',
    'moveNodes',
    'getEventScheduler',
    'iterateEvents',
] satisfies Operation[];

/** The operations each kind can occur on. A kind that is not here can occur on every operation. */
const ONLY_ON: Partial<Record<FaultKind, readonly Operation[]>> = {
    integrity: ['getFileDownloader'],
    'name-clash': ['getFileUploader'],
    'upload-part-way': ['getFileUploader', 'getFileRevisionUploader'],
};

export class Faults {
    private readonly faults: Fault[] = [];

    /** Sets a fault for the next call that matches it. Throws `FaultError` for a fault that cannot occur. */
    add(fault: Fault): void {
        this.faults.push(checkFault(fault));
    }

    /** The faults not yet consumed, in the order they were set. */
    pending(): Fault[] {
        return this.faults.map((fault) => ({ ...fault }));
    }

    /** Removes and returns the first fault on `operation` whose path is one of `targets`. */
    take(operation: Operation, targets: readonly (string | undefined)[]): Fault | undefined {
        const plain = new Set(targets.filter((target) => target !== undefined).map(plainPath));
        const index = this.faults.findIndex((fault) => fault.operation === operation && plain.has(fault.path));
        return index < 0 ? undefined : this.faults.splice(index, 1)[0];
    }
}

/** The error the SDK raises for a fault of `kind`. */
export function faultError(kind: FaultKind): Error {
    switch (kind) {
        case 'rate-limited':
            return Object.assign(new RateLimitedError('fake-drive: Too many server requests, please try again later'), { statusCode: 429 });
        case 'server-error':
            return Object.assign(new ServerError('fake-drive: Internal server error'), { statusCode: 500 });
        case 'unreachable':
            return new ConnectionError('fake-drive: the Drive cannot be reached');
        case 'integrity':
            return new IntegrityError('fake-drive: the data failed verification');
        case 'name-clash':
            return new NodeWithSameNameExistsValidationError('fake-drive: a node with this name already exists', NAME_TAKEN, undefined, false);
        case 'upload-part-way':
            return new ConnectionError('fake-drive: the upload failed part-way');
    }
}

/** `/a/b/` and `a/b` name one path. */
export function plainPath(path: string): string {
    return path.split('/').filter(Boolean).join('/');
}

function checkFault(value: unknown): Fault {
    if (typeof value !== 'object' || value === null) throw new FaultError('a fault is an object {kind, operation, path}');
    const { kind, operation, path } = value as Record<string, unknown>;
    if (!FAULT_KINDS.includes(kind as FaultKind)) throw new FaultError(`kind is not one of ${FAULT_KINDS.join(', ')}`);
    if (!OPERATIONS.includes(operation as Operation)) throw new FaultError(`operation is not an SDK method: ${String(operation)}`);
    if (typeof path !== 'string') throw new FaultError('path is not a string');
    const only = ONLY_ON[kind as FaultKind];
    if (only && !only.includes(operation as Operation)) throw new FaultError(`a ${String(kind)} fault occurs only on ${only.join(', ')}`);
    return { kind: kind as FaultKind, operation: operation as Operation, path: plainPath(path) };
}
