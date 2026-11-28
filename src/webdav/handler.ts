import {
    AbortError,
    ConnectionError,
    DecryptionError,
    IntegrityError,
    NodeWithSameNameExistsValidationError,
    RateLimitedError,
    ServerError,
    ValidationError,
} from '@protontech/drive-sdk';

import type { Logger } from '../../vendor/proton-drive-sdk-account';

import type { ByteRange } from '../drive/download';
import { DriveError } from '../drive/errors';
import type { DriveTree } from '../drive/tree';
import { servingRequest } from '../proton/crypto-pool';
import { FailedPutGuard } from './guard';
import { parsePath } from './paths';
import { etagFor, multistatusStream } from './xml';

/** The methods this serve answers; the other capabilities grow this as they land. */
const ALLOW = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE';

/**
 * A Depth: 1 listing with more children than this is large: only one large
 * listing of the same folder streams at a time, and the others wait (#183).
 */
export const LARGE_LISTING = 1_000;

/** The `Retry-After` for a Drive that cannot be reached. */
const UNREACHABLE_RETRY_SECONDS = 10;

export type HandlerOptions = {
    tree: DriveTree;
    logger: Logger;
    /**
     * Returns why Proton calls cannot work right now (no session, or Proton
     * rejected the refresh token), or `undefined` when they can. Checked
     * before each request, so a dead session costs no Proton traffic.
     */
    authProblem?: () => string | undefined;
    /** The failed-overwrite guard; a fresh one when omitted. */
    guard?: FailedPutGuard;
};

export type WebDavHandler = (request: Request) => Promise<Response>;

/** Maps WebDAV requests to `DriveTree` calls. */
export function createWebDavHandler(options: HandlerOptions): WebDavHandler {
    const { tree, logger } = options;
    const authProblem = options.authProblem ?? (() => undefined);
    const guard = options.guard ?? new FailedPutGuard();
    /** Per folder UID, the end of the last large listing of it that has started or waits. */
    const largeListings = new Map<string, Promise<void>>();

    return async (request) => {
        const started = performance.now();
        const url = new URL(request.url);
        let response: Response;
        try {
            if (request.method === 'OPTIONS') {
                response = new Response(null, { status: 200, headers: { DAV: '1', Allow: ALLOW, 'MS-Author-Via': 'DAV' } });
            } else {
                const problem = authProblem();
                if (problem) {
                    response = text(401, problem);
                } else {
                    // Its node-key unlocks go ahead of those of the requests before it, as a walk's (#159).
                    const read = request.method === 'GET' || request.method === 'HEAD';
                    response = await servingRequest({ read }, () => route(request, parsePath(url.pathname)));
                }
            }
        } catch (error: unknown) {
            response = errorResponse(error, authProblem(), tree, logger, `${request.method} ${url.pathname}`);
        }
        logger.info(
            `${request.method} ${url.pathname} -> ${response.status} (${Math.round(performance.now() - started)} ms)`,
        );
        return response;
    };

    async function route(request: Request, segments: string[]): Promise<Response> {
        switch (request.method) {
            case 'PROPFIND':
                return propfind(request, segments);
            case 'GET':
            case 'HEAD':
                return get(request, segments);
            case 'PUT':
                return put(request, segments);
            case 'DELETE':
                return remove(segments);
            case 'MKCOL':
                return mkcol(request, segments);
            case 'MOVE':
                return move(request, segments);
            default:
                return new Response(`${request.method} is not supported\n`, { status: 405, headers: { Allow: ALLOW } });
        }
    }

    async function propfind(request: Request, segments: string[]): Promise<Response> {
        const depth = request.headers.get('Depth') ?? 'infinity';
        if (depth !== '0' && depth !== '1') {
            return text(403, 'PROPFIND with Depth: infinity is not supported; use Depth: 0 or 1');
        }
        const entry = segments.length === 0 ? await tree.root() : await requireEntry(segments);
        const children = depth === '1' && entry.kind === 'folder' ? await tree.list(entry) : [];
        const turn = children.length > LARGE_LISTING ? largeListingTurn(entry.uid) : undefined;
        // A client that leaves before its body is read may never pull or cancel it.
        if (turn) request.signal.addEventListener('abort', turn.end, { once: true });
        return new Response(multistatusStream(segments, entry, children, { before: turn?.start, onEnd: turn?.end }), {
            status: 207,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
    }

    async function get(request: Request, segments: string[]): Promise<Response> {
        const entry = await requireEntry(segments);
        if (entry.kind === 'folder') {
            return text(405, 'GET on a folder is not supported; use PROPFIND');
        }
        const headers: Record<string, string> = {
            'Accept-Ranges': 'bytes',
            'Content-Type': entry.mediaType ?? 'application/octet-stream',
            'Last-Modified': entry.modified.toUTCString(),
            ETag: etagFor(entry),
        };
        const range = parseRange(request.headers.get('Range'), entry.size);
        if (range === 'unsatisfiable') {
            return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${entry.size}` } });
        }
        const status = range ? 206 : 200;
        const length = range ? range.end - range.start + 1 : entry.size;
        headers['Content-Length'] = String(length);
        if (range) {
            headers['Content-Range'] = `bytes ${range.start}-${range.end}/${entry.size}`;
        }
        // HEAD and empty files need no download, so they take no SDK download slot.
        if (request.method === 'HEAD' || length === 0) {
            return new Response(null, { status, headers });
        }
        const body = await tree.read(entry, range, request.signal);
        return new Response(body, { status, headers });
    }

    async function put(request: Request, segments: string[]): Promise<Response> {
        if (segments.length === 0) {
            return text(405, 'Cannot PUT to the root folder');
        }
        const contentLength = request.headers.get('Content-Length');
        const size = contentLength === null ? undefined : Number(contentLength);
        if (contentLength !== null && (!Number.isSafeInteger(size) || size! < 0)) {
            return text(400, `Bad Content-Length ${contentLength}`);
        }
        // Never turn a missing body into an empty file unless the client said "0 bytes".
        if (!request.body && size !== 0) {
            return text(
                400,
                contentLength === null
                    ? 'PUT has no body and no Content-Length'
                    : `PUT declared ${contentLength} bytes but has no body`,
            );
        }
        const path = segments.join('/');
        const existing = await tree.stat(segments);
        try {
            const { created } = await tree.upload(
                segments.slice(0, -1),
                segments[segments.length - 1],
                request.body ?? emptyStream(),
                {
                    size,
                    mediaType: mediaTypeOf(request),
                    modified: modifiedOf(request),
                },
                request.signal,
            );
            guard.release(path);
            return new Response(null, { status: created ? 201 : 204 });
        } catch (error: unknown) {
            if (existing?.kind === 'file') {
                // The old revision is still on Proton, and the client (rclone) will
                // DELETE the very same path to undo its failed PUT. Refuse that.
                guard.protect(path);
                logger.warn(`PUT /${path} failed on an existing file; DELETE of it is refused for a while`);
            }
            throw error;
        }
    }

    /** Trashes the file or folder, so the client sees 204 once Drive has it. */
    async function remove(segments: string[]): Promise<Response> {
        const path = segments.join('/');
        if (guard.isProtected(path)) {
            return text(
                423,
                `/${path} is protected after a failed overwrite, so its old content stays; try the DELETE again in a minute`,
            );
        }
        await tree.trash(segments);
        return new Response(null, { status: 204 });
    }

    /** Creates the folder, so the client sees 201 once Drive has it. */
    async function mkcol(request: Request, segments: string[]): Promise<Response> {
        if (segments.length === 0) {
            return text(405, 'The root folder already exists');
        }
        if (request.body) {
            return text(415, 'MKCOL carries a body, and a folder takes no content');
        }
        await tree.createFolder(segments.slice(0, -1), segments[segments.length - 1]);
        return new Response(null, { status: 201 });
    }

    /** Moves or renames an entry. */
    async function move(request: Request, segments: string[]): Promise<Response> {
        const destination = request.headers.get('Destination');
        if (!destination) {
            return text(400, 'MOVE needs a Destination header');
        }
        const destinationUrl = new URL(destination, request.url);
        if (destinationUrl.host !== new URL(request.url).host) {
            return text(502, 'MOVE to another server is not supported');
        }
        const overwrite = (request.headers.get('Overwrite') ?? 'T').toUpperCase() !== 'F';
        const { entry, created } = await tree.move(segments, parsePath(destinationUrl.pathname), overwrite);
        return new Response(null, { status: created ? 201 : 204 });
    }

    /**
     * A place in the queue of large listings of one folder. `start` resolves
     * once the listings ahead have ended; `end` lets the next one start.
     */
    function largeListingTurn(folderUid: string): { start: () => Promise<void>; end: () => void } {
        const ahead = largeListings.get(folderUid) ?? Promise.resolve();
        let end!: () => void;
        const ended = new Promise<void>((resolve) => (end = resolve));
        const last = ahead.then(() => ended);
        largeListings.set(folderUid, last);
        void last.then(() => {
            if (largeListings.get(folderUid) === last) {
                largeListings.delete(folderUid);
            }
        });
        return { start: () => ahead, end };
    }

    async function requireEntry(segments: string[]): Promise<NonNullable<Awaited<ReturnType<typeof tree.stat>>>> {
        const entry = await tree.stat(segments);
        if (!entry) {
            throw new DriveError(404, `/${segments.join('/')} not found`);
        }
        return entry;
    }
}

/**
 * Parses a single `bytes=` range. Returns `undefined` for no range or a form
 * we serve as a full 200 (several ranges, other units), and `'unsatisfiable'`
 * for a range outside the file.
 */
export function parseRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | undefined {
    if (!header) {
        return undefined;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) {
        return undefined;
    }
    const [, first, last] = match;
    if (first === '' && last === '') {
        return undefined;
    }
    if (first === '') {
        const suffix = Number(last);
        if (suffix === 0 || size === 0) {
            return 'unsatisfiable';
        }
        return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start = Number(first);
    const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
    if (start >= size || end < start) {
        return 'unsatisfiable';
    }
    return { start, end };
}

function emptyStream(): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.close();
        },
    });
}

/** The media type without its parameters, defaulting as a WebDAV server does. */
function mediaTypeOf(request: Request): string {
    return request.headers.get('Content-Type')?.split(';')[0].trim() || 'application/octet-stream';
}

/** Reads `X-OC-Mtime` (Unix seconds), which ownCloud-style clients send. */
function modifiedOf(request: Request): Date | undefined {
    const header = request.headers.get('X-OC-Mtime');
    if (!header) {
        return undefined;
    }
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined;
}

function errorResponse(error: unknown, authProblem: string | undefined, tree: DriveTree, logger: Logger, what: string): Response {
    if (error instanceof DriveError) {
        if (error.status >= 500) {
            logger.warn(`${what}: ${error.message}`);
        }
        const headers: Record<string, string> = {};
        if (error.retryAfterSeconds) {
            headers['Retry-After'] = String(error.retryAfterSeconds);
        }
        return text(error.status, error.message, headers);
    }
    if (authProblem) {
        return text(401, authProblem);
    }
    if (error instanceof AbortError) {
        return text(499, error.message);
    }
    if (error instanceof ConnectionError) {
        logger.warn(`${what}: Connection error: ${error.message}`);
        return text(503, `Connection error: ${error.message}`, { 'Retry-After': String(UNREACHABLE_RETRY_SECONDS) });
    }
    if (error instanceof DecryptionError) {
        logger.error(`${what}: Decryption error: ${error.message}`);
        return text(500, `Decryption error: ${error.message}`);
    }
    if (error instanceof IntegrityError) {
        logger.error(`${what}: Integrity error: ${error.message}`);
        return text(502, `Integrity error: ${error.message}`);
    }
    if (error instanceof NodeWithSameNameExistsValidationError) {
        return text(409, error.message);
    }
    if (error instanceof ValidationError) {
        return text(400, error.message);
    }
    if (error instanceof RateLimitedError) {
        logger.warn(`${what}: Proton rate limit: ${error.message}`);
        const retryAfter = Math.max(tree.backoff.coolingDownSeconds, 1);
        return text(503, `Proton rate limit: ${error.message}`, { 'Retry-After': String(retryAfter) });
    }
    if (error instanceof ServerError) {
        // A Proton failure (5xx, or none given) is a bad gateway; a 4xx Proton answered is passed on.
        const status = error.statusCode !== undefined && error.statusCode < 500 ? error.statusCode : 502;
        if (status >= 500) {
            logger.warn(`${what}: Server error: ${error.message}`);
        }
        return text(status, error.message);
    }
    logger.error(`${what}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return text(500, error instanceof Error ? error.message : String(error));
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
    return new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}
