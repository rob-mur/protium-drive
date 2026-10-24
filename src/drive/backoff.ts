import { RateLimitedError } from '@protontech/drive-sdk';

import { DriveError } from './errors';

const FIRST_COOL_DOWN_SECONDS = 30;
const MAX_COOL_DOWN_SECONDS = 15 * 60;

/**
 * Server-wide back-off after Proton answers 429.
 *
 * The SDK already waits and retries on each 429 and gives up with a
 * `RateLimitedError` after many in a row. When that happens, this class stops
 * all Proton calls for a cool-down period that doubles on each repeat, and the
 * WebDAV layer answers 503 with `Retry-After` instead of calling Proton.
 */
export class Backoff {
    private until = 0;
    private seconds = 0;

    constructor(private readonly now: () => number = Date.now) {}

    /** Throws a 503 `DriveError` while a cool-down is active. */
    check(): void {
        const remainingMs = this.until - this.now();
        if (remainingMs > 0) {
            const retryAfter = Math.ceil(remainingMs / 1000);
            throw new DriveError(503, `Proton rate limit: waiting ${retryAfter}s before the next request`, retryAfter);
        }
    }

    /** Runs `fn` unless a cool-down is active, and starts a cool-down if Proton rate-limits it. */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        this.check();
        try {
            const result = await fn();
            this.seconds = 0;
            return result;
        } catch (error: unknown) {
            this.note(error);
            throw error;
        }
    }

    note(error: unknown): void {
        if (!(error instanceof RateLimitedError)) {
            return;
        }
        this.seconds = Math.min(this.seconds ? this.seconds * 2 : FIRST_COOL_DOWN_SECONDS, MAX_COOL_DOWN_SECONDS);
        this.until = this.now() + this.seconds * 1000;
    }

    get coolingDownSeconds(): number {
        return Math.max(0, Math.ceil((this.until - this.now()) / 1000));
    }
}
