/**
 * The Receive arm's control channel: HTTP and JSON on 127.0.0.1, at a port the system allocates.
 * Step definitions use it to read the Drive and to change it as another client would. A path is
 * `/`-separated names from My files, sent as the `path` query parameter or body field.
 *
 *   GET  /node?path=P                  the node at P (NodeInfo)
 *   GET  /content?path=P[&revision=R]  the bytes of P's active revision, or of revision R
 *   GET  /revisions?path=P             P's revisions, oldest first (RevisionInfo[])
 *   GET  /trash                        the trashed nodes (NodeInfo[])
 *   GET  /calls                        the SDK call counts (CallCounts)
 *   POST /add      {path, type: "file" | "folder", content? | contentBase64?, mediaType?,
 *                   nameUndecryptable?, clearTextSize?}       -> {uid}
 *   POST /rename   {path, name}                               -> {uid}
 *   POST /trash    {path}                                     -> {uid}
 *   POST /events/fire                                         -> {scopes}: polls the event scheduler
 *
 * Errors: 404 for no node at the path or an unknown route, 409 for a name that is taken, 400 for
 * a bad request. Each error body is `{error}`.
 */
import { NodeWithSameNameExistsValidationError, ValidationError } from '@protontech/drive-sdk';

import { type AddSpec, type FakeDrive, type FakeDriveClient, NoSuchNodeError } from './drive.ts';

export type ControlChannel = {
    /** `http://127.0.0.1:<port>/` */
    url: URL;
    /** Stops listening. Calling it again does nothing. */
    stop(): Promise<void>;
};

class BadRequest extends Error {}

export function startControlChannel(drive: FakeDrive, client: FakeDriveClient): ControlChannel {
    const routes: Record<string, (request: Request, url: URL) => Promise<Response> | Response> = {
        'GET /node': (_, url) => Response.json(drive.nodeAt(param(url, 'path'))),
        'GET /content': (_, url) =>
            new Response(drive.content(param(url, 'path'), url.searchParams.get('revision') ?? undefined), {
                headers: { 'content-type': 'application/octet-stream' },
            }),
        'GET /revisions': (_, url) => Response.json(drive.revisions(param(url, 'path'))),
        'GET /trash': () => Response.json(drive.trashed()),
        'GET /calls': () => Response.json(client.calls()),
        'POST /add': async (request) => {
            const body = await jsonBody(request);
            return Response.json({ uid: drive.add(field(body, 'path'), addSpec(body)) });
        },
        'POST /rename': async (request) => {
            const body = await jsonBody(request);
            return Response.json({ uid: drive.rename(field(body, 'path'), field(body, 'name')) });
        },
        'POST /trash': async (request) => {
            const body = await jsonBody(request);
            return Response.json({ uid: drive.trash(field(body, 'path')) });
        },
        'POST /events/fire': async () => Response.json({ scopes: await client.fireEventScheduler() }),
    };

    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const route = routes[`${request.method} ${url.pathname}`];
            if (!route) return failure(404, `no route ${request.method} ${url.pathname}`);
            try {
                return await route(request, url);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                if (error instanceof NoSuchNodeError) return failure(404, message);
                if (error instanceof NodeWithSameNameExistsValidationError) return failure(409, message);
                if (error instanceof BadRequest || error instanceof ValidationError) return failure(400, message);
                return failure(500, message);
            }
        },
    });

    let stopped: Promise<void> | undefined;
    return {
        url: new URL(`http://127.0.0.1:${server.port}/`),
        stop: () => (stopped ??= server.stop(true)),
    };
}

function failure(status: number, error: string): Response {
    return Response.json({ error }, { status });
}

function param(url: URL, name: string): string {
    const value = url.searchParams.get(name);
    if (value === null) throw new BadRequest(`the query has no ${name}`);
    return value;
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        throw new BadRequest('the body is not JSON');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequest('the body is not a JSON object');
    return body as Record<string, unknown>;
}

function field(body: Record<string, unknown>, name: string): string {
    const value = body[name];
    if (typeof value !== 'string') throw new BadRequest(`the body has no string ${name}`);
    return value;
}

function flag(body: Record<string, unknown>, name: string): boolean | undefined {
    const value = body[name];
    if (value !== undefined && typeof value !== 'boolean') throw new BadRequest(`${name} is not a boolean`);
    return value;
}

function addSpec(body: Record<string, unknown>): AddSpec {
    if (body.type === 'folder') return { type: 'folder' };
    if (body.type !== 'file') throw new BadRequest('type is not "file" or "folder"');
    let content: Uint8Array;
    if (typeof body.content === 'string') content = new TextEncoder().encode(body.content);
    else if (typeof body.contentBase64 === 'string') content = fromBase64(body.contentBase64);
    else throw new BadRequest('a file needs content or contentBase64');
    if (body.mediaType !== undefined && typeof body.mediaType !== 'string') throw new BadRequest('mediaType is not a string');
    return {
        type: 'file',
        content,
        mediaType: body.mediaType,
        nameUndecryptable: flag(body, 'nameUndecryptable'),
        clearTextSize: flag(body, 'clearTextSize'),
    };
}

function fromBase64(text: string): Uint8Array {
    let binary: string;
    try {
        binary = atob(text);
    } catch {
        throw new BadRequest('contentBase64 is not base64');
    }
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
