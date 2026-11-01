import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm as rmAsync } from 'node:fs/promises';

import { afterEach, describe, expect, test } from 'bun:test';

import { authLogin } from './auth/login.ts';
import { createLogger } from './logger.ts';
import { serveCommand, NOT_SIGNED_IN, LOOPBACK_WARNING } from './serve.ts';

const DIRS: string[] = [];
const QUIET = createLogger({ PDM_LOG_LEVEL: 'error' });

function scratch(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `pdm-serve-${label}-XXXXXX`));
    DIRS.push(dir);
    return dir;
}

afterEach(async () => {
    while (DIRS.length) {
        const dir = DIRS.pop()!;
        await rmAsync(dir, { recursive: true, force: true }).catch(() => {});
    }
});

/** Signs in against the fake drive, as the user approves the sign-in in a browser. */
async function signIn(stateDir: string, driveDir: string): Promise<void> {
    let controlUrl: URL | undefined;
    const urlSeen = new Promise<void>((resolve) => {
        authLogin({
            stateDir,
            logger: QUIET,
            fakeDriveDir: driveDir,
            print: (line) => {
                if (/^https:\/\/\S+$/.test(line.trim())) resolve();
            },
            onControlUrl: (url) => {
                controlUrl = url;
            },
        }).then((code) => {
            expect(code).toBe(0);
        });
    });
    await urlSeen;
    await fetch(new URL('account/approve', controlUrl), { method: 'POST' });
}

describe('serveCommand', () => {
    test('refuses to start without a session, naming auth login, and exits 1', async () => {
        const stateDir = scratch('empty');
        const driveDir = scratch('drive');
        const errors: string[] = [];
        const logger = { ...QUIET, error: (line: string) => errors.push(line) };

        const code = await serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir });

        expect(code).toBe(1);
        expect(errors).toEqual([NOT_SIGNED_IN]);
    });

    test('serves an empty Drive: the root listing is empty', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        await signIn(stateDir, driveDir);
        const abort = new AbortController();
        const lines: string[] = [];
        const logger = { ...QUIET, info: (line: string) => lines.push(line) };
        const serving = serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        const servingLine = await waitFor(lines, 'Serving Proton Drive');
        const url = servingLine!.match(/https?:\/\/\S+/)![0];

        const propfind = await fetch(url, { method: 'PROPFIND', headers: { Depth: '1' } });
        const body = await propfind.text();
        abort.abort();
        expect(await serving).toBe(0);

        expect(propfind.status).toBe(207);
        expect(body).toContain('<D:multistatus');
        // The root is there; it has no children to list.
        expect(body).toContain('resourcetype><D:collection');
        expect(body.split('<D:response>').length - 1).toBe(1);
    });

    test('logs one line per request to stderr, level via PDM_LOG_LEVEL', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        await signIn(stateDir, driveDir);
        const abort = new AbortController();
        const infos: string[] = [];
        const logger = { ...QUIET, info: (line: string) => infos.push(line) };
        const serving = serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        const servingLine = await waitFor(infos, 'Serving Proton Drive');
        await fetch(servingLine!.match(/https?:\/\/\S+/)![0], { method: 'OPTIONS' });
        await fetch(`${servingLine!.match(/https?:\/\/\S+/)![0]}nope`, { method: 'PROPFIND', headers: { Depth: '0' } });
        abort.abort();
        await serving;

        const requestLines = infos.filter((line) => line.includes('->'));
        expect(requestLines.some((line) => line.startsWith('OPTIONS / -> 200'))).toBeTrue();
        expect(requestLines.some((line) => line.startsWith('PROPFIND /nope -> 404'))).toBeTrue();
    });

    test('warns when the host is not loopback: no authentication of its own', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        await signIn(stateDir, driveDir);
        const abort = new AbortController();
        const warns: string[] = [];
        const logger = { ...QUIET, warn: (line: string) => warns.push(line) };
        const serving = serveCommand({ stateDir, host: '0.0.0.0', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        await waitFor(warns, 'anyone who can reach it');
        abort.abort();
        expect(await serving).toBe(0);
        expect(warns).toContain(LOOPBACK_WARNING('0.0.0.0'));
    });

    test('never warns for the loopback hosts', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        await signIn(stateDir, driveDir);
        const abort = new AbortController();
        const warns: string[] = [];
        const infos: string[] = [];
        const logger = { ...QUIET, warn: (line: string) => warns.push(line), info: (line: string) => infos.push(line) };
        const serving = serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        await waitFor(infos, 'Serving Proton Drive');
        abort.abort();
        expect(await serving).toBe(0);
        expect(warns).toEqual([]);
    });

    test('a second serve on one state directory is refused, naming the first pid', async () => {
        const stateDir = scratch('state');
        const driveDir = scratch('drive');
        await signIn(stateDir, driveDir);
        const abort = new AbortController();
        const infos: string[] = [];
        const logger = { ...QUIET, info: (line: string) => infos.push(line) };
        const first = serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger, fakeDriveDir: driveDir, signal: abort.signal });
        await waitFor(infos, 'Serving Proton Drive');

        let secondError: unknown;
        try {
            await serveCommand({ stateDir, host: '127.0.0.1', port: 0, logger: QUIET, fakeDriveDir: scratch('other') });
        } catch (error: unknown) {
            secondError = error;
        }
        abort.abort();
        expect(await first).toBe(0);
        expect(String(secondError)).toContain(`pid ${process.pid}`);
        expect(String(secondError)).toContain(stateDir);
    });
});

async function waitFor(lines: string[], part: string): Promise<string | undefined> {
    for (let i = 0; i < 500; i++) {
        const line = lines.find((l) => l.includes(part));
        if (line !== undefined) {
            return line;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
}
