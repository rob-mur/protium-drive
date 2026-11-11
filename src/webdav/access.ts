import { createHash, timingSafeEqual } from 'node:crypto';

import type { Logger } from '../../vendor/proton-drive-sdk-account';

import type { WebDavHandler } from './handler';

export const MISDIRECTED =
    'This serve answers only to localhost, 127.0.0.1, ::1 and its --host; the request named another host.';
export const MISSING_CREDENTIAL = "The request lacks the mount's credential; only the mount's rclone may use this port.";

/** The names that always reach this machine's loopback, whatever DNS says. */
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];

export type AccessOptions = {
    /** The address the serve listens on; a request may name it as well as the loopback names. */
    host: string;
    /** When set, every request must carry `Authorization: Bearer <credential>`. */
    credential?: string;
    logger: Logger;
};

/**
 * Puts two checks in front of `handler`, before any Drive call and before OPTIONS:
 * the Host header must name loopback or the listen address, so a web page that reached
 * the port by DNS rebinding gets 421; and, when a credential is set, the request must
 * carry it, so another local program gets 401.
 */
export function guardAccess(handler: WebDavHandler, options: AccessOptions): WebDavHandler {
    const allowed = new Set([...LOOPBACK_NAMES, hostnameOf(options.host.includes(':') ? `[${options.host}]` : options.host)]);
    const expected = options.credential === undefined ? undefined : digest(`Bearer ${options.credential}`);
    return async (request) => {
        const host = request.headers.get('host') ?? '';
        const what = `${request.method} ${new URL(request.url).pathname}`;
        if (!allowed.has(hostnameOf(host))) {
            options.logger.warn(`${what} refused: Host "${host}" is not this serve`);
            return refusal(421, MISDIRECTED);
        }
        if (expected && !timingSafeEqual(digest(request.headers.get('authorization') ?? ''), expected)) {
            options.logger.warn(`${what} refused: no mount credential`);
            return refusal(401, MISSING_CREDENTIAL, { 'WWW-Authenticate': 'Bearer' });
        }
        return handler(request);
    };
}

/** The lower-case hostname of a Host header (`name`, `name:port`, `[v6]:port`); '' when it is not one. */
function hostnameOf(host: string): string {
    if (host === '' || /[\s/?#@]/.test(host)) return '';
    try {
        return new URL(`http://${host}`).hostname.toLowerCase();
    } catch {
        return '';
    }
}

/** Fixed-length, so the compare takes the same time whatever length the client sent. */
function digest(value: string): Buffer {
    return createHash('sha256').update(value).digest();
}

function refusal(status: number, message: string, headers: Record<string, string> = {}): Response {
    return new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}
