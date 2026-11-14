import { afterEach, describe, expect, test } from 'bun:test';

import { createLogger, logLevel } from './logger.ts';

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
