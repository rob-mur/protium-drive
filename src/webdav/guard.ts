/**
 * How long a path refuses DELETE after a failed overwrite.
 *
 * rclone's webdav backend sends a DELETE for the target whenever a PUT fails.
 * When the PUT was a new revision of an existing file, the old content is
 * still intact on Proton, and that DELETE would trash it. rclone waits about a
 * second before the DELETE, but retries and slow clients can stretch that, so
 * the window is generous. A user who really wants to delete the file in that
 * window gets a 423 and can try again a minute later.
 */
export const FAILED_PUT_GUARD_MS = 60_000;

/** Remembers paths whose overwrite just failed, and refuses DELETE on them for a while. */
export class FailedPutGuard {
    private readonly until = new Map<string, number>();

    constructor(
        private readonly windowMs = FAILED_PUT_GUARD_MS,
        private readonly now: () => number = Date.now,
    ) {}

    protect(path: string): void {
        this.prune();
        this.until.set(path, this.now() + this.windowMs);
    }

    /** Called after a successful PUT: the client has written good content again. */
    release(path: string): void {
        this.until.delete(path);
    }

    isProtected(path: string): boolean {
        this.prune();
        return this.until.has(path);
    }

    private prune(): void {
        const now = this.now();
        for (const [path, until] of this.until) {
            if (until <= now) {
                this.until.delete(path);
            }
        }
    }
}
