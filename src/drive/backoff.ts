import { RateLimitedError } from '@protontech/drive-sdk';

import { DriveError } from './errors.ts';

const FIRST_COOL_DOWN_SECONDS = 30;
const MAX_COOL_DOWN_SECONDS = 15 * 60;

/**
 * Server-wide pause after Proton answers 429.
 *
 * The SDK already waits and retries on each 429 and gives up with a
 * `RateLimitedError` after many in a row. When that happens, this class stops
 * all Proton calls for a cool-down that starts at 30 s, doubles on each repeat
 * up to 15 min, and that a succeeded call resets to 30 s. While it lasts, the
 * Drive layer answers 503 with `Retry-After` instead of calling Proton.
 */
export class Backoff {
    private until = 0;
    private seconds = 0;

    constructor(private readonly now: () => number = Date.now) {}

    /** Throws a 503 `DriveError` carrying the seconds left while a pause is active. */
    check(): void {
        const remainingMs = this.until - this.now();
        if (remainingMs > 0) {
            const retryAfter = Math.ceil(remainingMs / 1000);
            throw new DriveError(503, `Proton rate limit: waiting ${retryAfter}s before the next request`, retryAfter);
        }
    }

    /** Runs `fn` unless a pause is active, and starts a pause if Proton rate-limits it. */
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

    /** Starts or doubles the pause; other errors leave it alone. */
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
