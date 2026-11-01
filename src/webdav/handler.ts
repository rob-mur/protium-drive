import type { Logger } from '../../vendor/proton-drive-sdk-account';

import { DriveError } from '../drive/errors';
import type { DriveTree } from '../drive/tree';
import { parsePath } from './paths';
import { multistatus } from './xml';

/** The methods this serve answers; the other capabilities grow this as they land. */
const ALLOW = 'OPTIONS, PROPFIND';

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

    async function requireEntry(segments: string[]): Promise<NonNullable<Awaited<ReturnType<typeof tree.stat>>>> {
        const entry = await tree.stat(segments);
        if (!entry) {
            throw new DriveError(404, `/${segments.join('/')} not found`);
        }
        return entry;
    }
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
