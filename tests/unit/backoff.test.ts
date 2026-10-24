import { describe, expect, test } from 'bun:test';

import { RateLimitedError, ServerError } from '@protontech/drive-sdk';

import { Backoff } from '../../src/drive/backoff';
import { DriveError } from '../../src/drive/errors';

describe('Backoff', () => {
    test('starts a cool-down on RateLimitedError and doubles it on repeats', async () => {
        let now = 0;
        const backoff = new Backoff(() => now);
        await expect(backoff.run(() => Promise.reject(new RateLimitedError('slow down')))).rejects.toBeInstanceOf(RateLimitedError);
        expect(backoff.coolingDownSeconds).toBe(30);
        expect(() => backoff.check()).toThrow(DriveError);
        try {
            backoff.check();
        } catch (error) {
            expect((error as DriveError).status).toBe(503);
            expect((error as DriveError).retryAfterSeconds).toBe(30);
        }

        now += 31_000;
        backoff.note(new RateLimitedError('again'));
        expect(backoff.coolingDownSeconds).toBe(60);
    });

    test('a call in the cool-down does not reach Proton', async () => {
        let now = 0;
        const backoff = new Backoff(() => now);
        backoff.note(new RateLimitedError('slow down'));
        let called = false;
        await expect(backoff.run(async () => { called = true; })).rejects.toBeInstanceOf(DriveError);
        expect(called).toBe(false);
    });

    test('caps the cool-down and resets after a success', async () => {
        let now = 0;
        const backoff = new Backoff(() => now);
        for (let i = 0; i < 10; i++) {
            backoff.note(new RateLimitedError('slow down'));
        }
        expect(backoff.coolingDownSeconds).toBe(900);
        now += 901_000;
        await backoff.run(async () => 'ok');
        backoff.note(new RateLimitedError('slow down'));
        expect(backoff.coolingDownSeconds).toBe(30);
    });

    test('ignores other errors', () => {
        const backoff = new Backoff(() => 0);
        backoff.note(new ServerError('boom'));
        backoff.note(new Error('boom'));
        expect(backoff.coolingDownSeconds).toBe(0);
    });
});
