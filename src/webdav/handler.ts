import type { Logger } from '../../vendor/proton-drive-sdk-account';

import type { ByteRange } from '../drive/download';
import { DriveError } from '../drive/errors';
import type { DriveTree } from '../drive/tree';
import { parsePath } from './paths';
import { etagFor, multistatus } from './xml';

/** The methods this serve answers; the other capabilities grow this as they land. */
const ALLOW = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE';

export type HandlerOptions = {
    tree: DriveTree;
    logger: Logger;
};

export type WebDavHandler = (request: Request) => Promise<Response>;

/** Maps WebDAV requests to `DriveTree` calls. */
export function createWebDavHandler(options: HandlerOptions): WebDavHandler {
    const { tree, logger } = options;

    return async (request) => {
        const started = performance.now();
        const url = new URL(request.url);
        let response: Response;
        try {
            if (request.method === 'OPTIONS') {
                response = new Response(null, { status: 200, headers: { DAV: '1', Allow: ALLOW, 'MS-Author-Via': 'DAV' } });
            } else {
                response = await route(request, parsePath(url.pathname));
            }
        } catch (error: unknown) {
            response = errorResponse(error, logger, `${request.method} ${url.pathname}`);
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
        return new Response(multistatus(segments, entry, children), {
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
        return new Response(null, { status: created ? 201 : 204 });
    }

    /** Trashes the file or folder, so the client sees 204 once Drive has it. */
    async function remove(segments: string[]): Promise<Response> {
        await tree.trash(segments);
        return new Response(null, { status: 204 });
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

function errorResponse(error: unknown, logger: Logger, what: string): Response {
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
    logger.error(`${what}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return text(500, error instanceof Error ? error.message : String(error));
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
    return new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}
