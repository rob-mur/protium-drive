import { describe, expect, test } from 'bun:test';

import { RateLimitedError, ServerError } from '@protontech/drive-sdk';

import { Backoff } from './backoff.ts';
import { DriveError } from './errors.ts';

describe('Backoff', () => {
    test('a rate limit starts a 30 second cool-down', () => {
        let now = 0;
        const backoff = new Backoff(() => now);
        backoff.note(new RateLimitedError('slow down'));
        expect(backoff.coolingDownSeconds).toBe(30);
        try {
            backoff.check();
            throw new Error('check should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(DriveError);
            const driveError = error as DriveError;
            expect(driveError.status).toBe(503);
            expect(driveError.retryAfterSeconds).toBe(30);
        }
    });

    test('the seconds left shrink as the clock moves', () => {
        let now = 0;
        const backoff = new Backoff(() => now);
        backoff.note(new RateLimitedError('slow down'));
        now += 10_000;
        expect(backoff.coolingDownSeconds).toBe(20);
        try {
            backoff.check();
            throw new Error('check should have thrown');
        } catch (error) {
            expect((error as DriveError).retryAfterSeconds).toBe(20);
        }
    });

    test('a second rate limit doubles the pause, and repeats stop growing at 15 minutes', () => {
        let now = 0;
        const backoff = new Backoff(() => now);
        backoff.note(new RateLimitedError('first'));
        now += 31_000;
        backoff.note(new RateLimitedError('second'));
        expect(backoff.coolingDownSeconds).toBe(60);
        for (let limit = 4; limit > 0; limit--) {
            now += 61_000;
            backoff.note(new RateLimitedError('again'));
        }
        expect(backoff.coolingDownSeconds).toBe(900);
        now += 901_000;
        backoff.note(new RateLimitedError('still'));
        expect(backoff.coolingDownSeconds).toBe(900);
    });

    test('a call in the cool-down is refused without reaching Drive', async () => {
        let now = 0;
        const backoff = new Backoff(() => now);
        backoff.note(new RateLimitedError('slow down'));
        let called = false;
        await expect(backoff.run(async () => void (called = true))).rejects.toBeInstanceOf(DriveError);
        expect(called).toBe(false);
    });

    test('a succeeded call resets the next pause to 30 seconds', async () => {
        let now = 0;
        const backoff = new Backoff(() => now);
        backoff.note(new RateLimitedError('slow down'));
        now += 31_000;
        await backoff.run(async () => 'ok');
        backoff.note(new RateLimitedError('slow down'));
        expect(backoff.coolingDownSeconds).toBe(30);
    });

    test('other errors pass through and start no pause', async () => {
        let now = 0;
        const backoff = new Backoff(() => now);
        backoff.note(new ServerError('boom'));
        backoff.note(new Error('boom'));
        expect(backoff.coolingDownSeconds).toBe(0);
        await expect(backoff.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        expect(backoff.coolingDownSeconds).toBe(0);
    });
});
