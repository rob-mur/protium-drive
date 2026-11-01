import { afterEach, describe, expect, test } from 'bun:test';

import { createLogger } from './logger.ts';

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
        createLogger({}).debug('hidden');
        createLogger({}).info('shown');
        expect(lines.join('')).toContain('info: shown');
        expect(lines.join('')).not.toContain('hidden');
    });

    test('PDM_LOG_LEVEL=debug lets debug through', () => {
        const lines = capture({});
        createLogger({ PDM_LOG_LEVEL: 'debug' }).debug('visible');
        expect(lines.join('')).toContain('debug: visible');
    });
});
