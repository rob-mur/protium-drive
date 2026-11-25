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
 *                   nameUndecryptable?, clearTextSize?, nodeKey?, modificationTime?}   -> {uid}
 *                   nodeKey is "v4" (the default) or "argon2" (node-keys.ts); modificationTime is
 *                   the ISO 8601 time the upload claims. A file that exists gets a new revision.
 *   POST /rename   {path, name}                               -> {uid}
 *   POST /trash    {path}                                     -> {uid}
 *   POST /events/fire                                         -> {scopes}: polls the event scheduler
 *
 * With the clock, the faults and the account (the Receive arm always has them):
 *
 *   GET  /clock                        {now}: the clock's time, in ms since the epoch
 *   POST /clock/advance  {seconds}     -> {now, fired}: moves the clock on, and fires each timer due
 *   GET  /faults                       the faults no call has consumed yet (Fault[], faults.ts)
 *   POST /faults   {kind, operation, path}                    -> {pending}
 *   GET  /account                      the sign-ins and the refreshes (AccountReport, account.ts)
 *   POST /account/approve              -> {approved}: approves the sign-ins that wait
 *   POST /account/expire               -> {expired}: expires the access token of every session
 *   POST /account/refuse-next-refresh  -> {refuseNextRefresh: true}
 *
 * With the requirements (the Receive arm always has them):
 *
 *   GET  /requirements                 what Proton's requirement headers say now (RequirementSpec)
 *   POST /requirements  {drive?, photos?, docs?, required?, suggested?}  -> the RequirementSpec set
 *                   Replaces what was set; `{}` sets nothing. drive, photos and docs are the feature
 *                   mask Proton requires for that scope; required and suggested are SDK versions
 *                   such as "99.0.0". After each SDK call, the product's response hooks get a
 *                   response that carries them as Proton's headers (requirements.ts).
 *
 * Errors: 404 for no node at the path or an unknown route, 409 for a name that is taken or an
 * approval with no sign-in waiting, 400 for a bad request, a fault that cannot occur or a
 * requirement that is not one. Each error
 * body is `{error}`.
 */
import { NodeWithSameNameExistsValidationError, ValidationError } from '@protontech/drive-sdk';

import type { FakeAccount } from './account.ts';
import type { FakeClock } from './clock.ts';
import { type AddSpec, type FakeDrive, type FakeDriveClient, NoSuchNodeError } from './drive.ts';
import { type Fault, FaultError, type Faults } from './faults.ts';
import type { NodeKeyKind } from './node-keys.ts';
import { RequirementError, type Requirements } from './requirements.ts';

export type ControlChannel = {
    /** `http://127.0.0.1:<port>/` */
    url: URL;
    /** Stops listening. Calling it again does nothing. */
    stop(): Promise<void>;
};

/** What the control channel also drives, when it has it. */
export type ControlExtras = {
    clock?: FakeClock;
    faults?: Faults;
    account?: FakeAccount;
    requirements?: Requirements;
};

type Route = (request: Request, url: URL) => Promise<Response> | Response;

class BadRequest extends Error {}
class Conflict extends Error {}

export function startControlChannel(drive: FakeDrive, client: FakeDriveClient, extras: ControlExtras = {}): ControlChannel {
    const routes: Record<string, Route> = {
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
        ...clockRoutes(extras.clock),
        ...faultRoutes(extras.faults),
        ...accountRoutes(extras.account),
        ...requirementRoutes(extras.requirements),
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
                if (error instanceof NodeWithSameNameExistsValidationError || error instanceof Conflict) return failure(409, message);
                if (error instanceof BadRequest || error instanceof ValidationError || error instanceof FaultError || error instanceof RequirementError) return failure(400, message);
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

function clockRoutes(clock: FakeClock | undefined): Record<string, Route> {
    if (!clock) return {};
    return {
        'GET /clock': () => Response.json({ now: clock.now() }),
        'POST /clock/advance': async (request) => {
            const seconds = (await jsonBody(request)).seconds;
            const ms = typeof seconds === 'number' ? seconds * 1000 : Number.NaN;
            if (!Number.isFinite(clock.now() + ms) || ms < 0) throw new BadRequest('seconds is not a number of 0 or more that the clock can reach');
            return Response.json(await clock.advance(ms));
        },
    };
}

function faultRoutes(faults: Faults | undefined): Record<string, Route> {
    if (!faults) return {};
    return {
        'GET /faults': () => Response.json(faults.pending()),
        'POST /faults': async (request) => {
            faults.add((await jsonBody(request)) as Fault);
            return Response.json({ pending: faults.pending() });
        },
    };
}

function accountRoutes(account: FakeAccount | undefined): Record<string, Route> {
    if (!account) return {};
    return {
        'GET /account': () => Response.json(account.report()),
        'POST /account/approve': () => {
            const approved = account.approve();
            if (approved === 0) throw new Conflict('no sign-in waits for an approval');
            return Response.json({ approved });
        },
        'POST /account/expire': () => Response.json({ expired: account.expireAccessToken() }),
        'POST /account/refuse-next-refresh': () => {
            account.refuseNextRefresh();
            return Response.json({ refuseNextRefresh: true });
        },
    };
}

function requirementRoutes(requirements: Requirements | undefined): Record<string, Route> {
    if (!requirements) return {};
    return {
        'GET /requirements': () => Response.json(requirements.current()),
        'POST /requirements': async (request) => Response.json(requirements.set(await jsonBody(request))),
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
        nodeKey: nodeKey(body),
        modificationTime: modificationTime(body),
    };
}

function modificationTime(body: Record<string, unknown>): Date | undefined {
    const value = body.modificationTime;
    if (value === undefined) return undefined;
    const time = typeof value === 'string' ? new Date(value) : undefined;
    if (!time || Number.isNaN(time.getTime())) throw new BadRequest('modificationTime is not an ISO 8601 time');
    return time;
}

function nodeKey(body: Record<string, unknown>): NodeKeyKind | undefined {
    const value = body.nodeKey;
    if (value !== undefined && value !== 'v4' && value !== 'argon2') throw new BadRequest('nodeKey is not "v4" or "argon2"');
    return value;
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
