import { afterEach, describe, expect, test } from 'bun:test';
import { AbortError } from '@protontech/drive-sdk';

import { createLogger, createTelemetry, logLevel, withUploadRequest } from './logger.ts';

let restore: (() => void) | undefined;

function capture(env: NodeJS.ProcessEnv): string[] {
    const lines: string[] = [];
    const real = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
    }) as typeof process.stderr.write;
    restore = () => {
        process.stderr.write = real;
    };
    return lines;
}

afterEach(() => {
    restore?.();
    restore = undefined;
});

describe('createLogger', () => {
    test('info goes to stderr, debug stays quiet at the default level', () => {
        const lines = capture({});
        createLogger().debug('hidden');
        createLogger().info('shown');
        expect(lines.join('')).toContain('info: shown');
        expect(lines.join('')).not.toContain('hidden');
    });

    test('debug lets debug through', () => {
        const lines = capture({});
        createLogger('debug').debug('visible');
        expect(lines.join('')).toContain('debug: visible');
    });

    test('error keeps info and warn quiet', () => {
        const lines = capture({});
        const logger = createLogger('error');
        logger.info('hidden');
        logger.warn('hidden');
        logger.error('shown');
        expect(lines.join('')).toBe('error: shown\n');
    });

    test('CR, LF and other control characters in a line are escaped, so a value cannot forge a second line', () => {
        const lines = capture({});
        createLogger().error("GET /x: Header has invalid value: 'text/plain\r\nerror: forged'", 'a\x01b\x7fc\nd', '\u2028');
        expect(lines).toEqual(["error: GET /x: Header has invalid value: 'text/plain\\r\\nerror: forged' a\\x01b\\x7fc\\nd \\u2028\n"]);
    });
});

describe('logLevel', () => {
    test('is info when neither --log-level nor PDM_LOG_LEVEL is given', () => {
        expect(logLevel(undefined, {})).toBe('info');
    });

    test('takes each level from --log-level or from PDM_LOG_LEVEL', () => {
        for (const level of ['debug', 'info', 'warn', 'error']) {
            expect(logLevel(level, {})).toBe(level);
            expect(logLevel(undefined, { PDM_LOG_LEVEL: level })).toBe(level);
        }
    });

    test('--log-level wins over PDM_LOG_LEVEL', () => {
        expect(logLevel('error', { PDM_LOG_LEVEL: 'debug' })).toBe('error');
    });

    test('refuses a value that is not a level, naming where it came from and the value', () => {
        for (const [flag, env, names] of [
            ['loud', {}, '--log-level "loud"'],
            ['', {}, '--log-level ""'],
            ['DEBUG', {}, '--log-level "DEBUG"'],
            [undefined, { PDM_LOG_LEVEL: 'loud' }, 'PDM_LOG_LEVEL "loud"'],
            [undefined, { PDM_LOG_LEVEL: '' }, 'PDM_LOG_LEVEL ""'],
        ] as const) {
            const level = logLevel(flag, env);
            expect(level).toContain(names);
            expect(level).toContain('debug, info, warn or error');
        }
    });
});

describe('createTelemetry', () => {
    /** A logger that records each line as `level: message error`. */
    function recordingLogger() {
        const lines: string[] = [];
        const at = (level: string) => (message: string, ...args: unknown[]) =>
            void lines.push([`${level}: ${message}`, ...args.map(String)].join(' '));
        return { lines, logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } };
    }

    const aborted = () => {
        const client = new AbortController();
        client.abort();
        return client.signal;
    };

    test('an AbortError from an upload whose client request aborted is a warning, in the same words', async () => {
        const { lines, logger } = recordingLogger();
        const sdk = createTelemetry(logger).getLogger('upload');
        await withUploadRequest(aborted(), async () => {
            await Promise.resolve();
            sdk.error('Upload failed', new AbortError('Request aborted'));
        });
        expect(lines).toEqual(['warn: [upload] Upload failed AbortError: Request aborted']);
    });

    test('an AbortError from an upload whose client request did not abort, as at a stall, is an error', async () => {
        const { lines, logger } = recordingLogger();
        const sdk = createTelemetry(logger).getLogger('upload');
        await withUploadRequest(new AbortController().signal, async () => {
            sdk.error('Upload failed', new AbortError('Request aborted'));
        });
        expect(lines).toEqual(['error: [upload] Upload failed AbortError: Request aborted']);
    });

    test('a failure that is not an abort is an error, even when the client request aborted', async () => {
        const { lines, logger } = recordingLogger();
        const sdk = createTelemetry(logger).getLogger('upload');
        await withUploadRequest(aborted(), async () => {
            sdk.error('Upload failed', new Error('Proton API error'));
        });
        expect(lines).toEqual(['error: [upload] Upload failed Error: Proton API error']);
    });

    test('an AbortError outside an upload, or in an upload with no client request, is an error', async () => {
        const { lines, logger } = recordingLogger();
        const sdk = createTelemetry(logger).getLogger('upload');
        sdk.error('Upload failed', new AbortError('Request aborted'));
        await withUploadRequest(undefined, async () => {
            sdk.error('Upload failed', new AbortError('Request aborted'));
        });
        expect(lines).toEqual([
            'error: [upload] Upload failed AbortError: Request aborted',
            'error: [upload] Upload failed AbortError: Request aborted',
        ]);
    });

    test('two uploads at once keep apart: only the one whose client aborted logs a warning', async () => {
        const { lines, logger } = recordingLogger();
        const sdk = createTelemetry(logger).getLogger('upload');
        const client = new AbortController();
        let failBoth!: () => void;
        const together = new Promise<void>((resolve) => (failBoth = resolve));
        const one = withUploadRequest(client.signal, async () => {
            await together;
            sdk.error('Upload failed', new AbortError('one'));
        });
        const other = withUploadRequest(new AbortController().signal, async () => {
            await together;
            sdk.error('Upload failed', new AbortError('other'));
        });
        client.abort();
        failBoth();
        await Promise.all([one, other]);
        expect(lines.sort()).toEqual([
            'error: [upload] Upload failed AbortError: other',
            'warn: [upload] Upload failed AbortError: one',
        ]);
    });
});
