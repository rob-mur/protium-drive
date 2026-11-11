import { describe, expect, test } from 'bun:test';

import { guardAccess, MISSING_CREDENTIAL, MISDIRECTED } from './access.ts';

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

/** A handler that counts the requests that got through to it. */
function counting() {
    const seen: string[] = [];
    const handler = async (request: Request) => {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response('through', { status: 207 });
    };
    return { seen, handler };
}

function request(host: string | undefined, init: { method?: string; authorization?: string } = {}) {
    const headers = new Headers();
    if (host !== undefined) headers.set('host', host);
    if (init.authorization) headers.set('authorization', init.authorization);
    return new Request('http://127.0.0.1:7395/Photos/', { method: init.method ?? 'PROPFIND', headers });
}

describe('the Host check', () => {
    for (const host of ['127.0.0.1:7395', 'localhost:7395', '[::1]:7395', 'LOCALHOST:7395', 'localhost']) {
        test(`lets ${host} through`, async () => {
            const { seen, handler } = counting();
            const response = await guardAccess(handler, { host: '127.0.0.1', logger: QUIET })(request(host));
            expect(response.status).toBe(207);
            expect(seen).toEqual(['PROPFIND /Photos/']);
        });
    }

    for (const host of ['evil.example:7395', 'evil.example', '127.0.0.1.evil.example:7395', '10.0.0.5:7395', '']) {
        test(`refuses "${host}" as misdirected without reaching the handler`, async () => {
            const { seen, handler } = counting();
            const response = await guardAccess(handler, { host: '127.0.0.1', logger: QUIET })(request(host));
            expect(response.status).toBe(421);
            expect(await response.text()).toContain(MISDIRECTED);
            expect(seen).toEqual([]);
        });
    }

    test('refuses OPTIONS under a foreign name too', async () => {
        const { seen, handler } = counting();
        const response = await guardAccess(handler, { host: '127.0.0.1', logger: QUIET })(
            request('evil.example:7395', { method: 'OPTIONS' }),
        );
        expect(response.status).toBe(421);
        expect(seen).toEqual([]);
    });

    test('lets the name the serve was told to listen on through', async () => {
        const { seen, handler } = counting();
        const gate = guardAccess(handler, { host: '192.168.1.20', logger: QUIET });
        expect((await gate(request('192.168.1.20:7395'))).status).toBe(207);
        expect((await gate(request('192.168.1.21:7395'))).status).toBe(421);
        expect(seen).toHaveLength(1);
    });

    test('logs the refusal', async () => {
        const lines: string[] = [];
        const { handler } = counting();
        await guardAccess(handler, { host: '127.0.0.1', logger: { ...QUIET, warn: (line: string) => lines.push(line) } })(
            request('evil.example:7395'),
        );
        expect(lines.join('\n')).toContain('evil.example');
    });
});

describe('the credential check', () => {
    const credential = 'c2VjcmV0LXRva2VuLWZvci10aGUtbW91bnQ';

    test('lets a request with the credential through', async () => {
        const { seen, handler } = counting();
        const response = await guardAccess(handler, { host: '127.0.0.1', credential, logger: QUIET })(
            request('127.0.0.1:7395', { authorization: `Bearer ${credential}` }),
        );
        expect(response.status).toBe(207);
        expect(seen).toHaveLength(1);
    });

    for (const [name, authorization] of [
        ['no Authorization', undefined],
        ['a wrong token', 'Bearer c2VjcmV0LXRva2VuLWZvci10aGUtbW91bnX'],
        ['a shorter token', 'Bearer c2VjcmV0'],
        ['basic auth', `Basic ${credential}`],
    ] as const) {
        test(`refuses ${name} with 401 without reaching the handler`, async () => {
            const { seen, handler } = counting();
            const response = await guardAccess(handler, { host: '127.0.0.1', credential, logger: QUIET })(
                request('127.0.0.1:7395', { authorization }),
            );
            expect(response.status).toBe(401);
            expect(await response.text()).toContain(MISSING_CREDENTIAL);
            expect(response.headers.get('www-authenticate')).toBe('Bearer');
            expect(seen).toEqual([]);
        });
    }

    test('refuses OPTIONS without the credential too', async () => {
        const { seen, handler } = counting();
        const response = await guardAccess(handler, { host: '127.0.0.1', credential, logger: QUIET })(
            request('127.0.0.1:7395', { method: 'OPTIONS' }),
        );
        expect(response.status).toBe(401);
        expect(seen).toEqual([]);
    });

    test('checks the Host before the credential', async () => {
        const { handler } = counting();
        const response = await guardAccess(handler, { host: '127.0.0.1', credential, logger: QUIET })(
            request('evil.example:7395', { authorization: `Bearer ${credential}` }),
        );
        expect(response.status).toBe(421);
    });
});
