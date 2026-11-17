/**
 * How often a running serve saves its listings. A kill, a crash or a power loss then loses at
 * most this much listing work; the save at a clean stop still saves the rest.
 */
export const LISTING_SAVE_INTERVAL_MS = 30_000;

export type ListingSaverOptions = {
    /**
     * What the save would write, as a value that changes whenever that changes; `undefined`
     * when there is nothing to save yet. A tick whose state equals the last saved one writes nothing.
     */
    state: () => string | undefined;
    /** Writes the listings; throws when it cannot. */
    save: () => Promise<void>;
    /** Called with the error of a save that failed after the last one worked. */
    onError?: (error: unknown) => void;
    /** The timer the ticks use; the fake drive's clock under `--fake-drive`. */
    setTimeout?: (callback: () => unknown, ms: number) => unknown;
    clearTimeout?: (handle: never) => void;
};

/**
 * Saves the serve's listings every LISTING_SAVE_INTERVAL_MS while it runs, so they survive an
 * unclean stop. A failed save is tried again on the next tick. `stop` waits for a save in
 * progress, so the final save at shutdown never writes beside it.
 */
export class ListingSaver {
    private timer?: unknown;
    private stopped = false;
    private saving: Promise<void> = Promise.resolve();
    private savedState?: string;
    private failing = false;

    constructor(private readonly options: ListingSaverOptions) {}

    start(): void {
        this.schedule();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer !== undefined) {
            (this.options.clearTimeout ?? clearTimeout)(this.timer as never);
            this.timer = undefined;
        }
        await this.saving;
    }

    private schedule(): void {
        if (this.stopped) {
            return;
        }
        const setTimer = this.options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
        this.timer = setTimer(() => this.tick(), LISTING_SAVE_INTERVAL_MS);
    }

    private tick(): Promise<void> {
        this.timer = undefined;
        this.saving = this.saveIfChanged().finally(() => this.schedule());
        return this.saving;
    }

    private async saveIfChanged(): Promise<void> {
        const state = this.options.state();
        if (state === undefined || state === this.savedState) {
            return;
        }
        try {
            await this.options.save();
            this.savedState = state;
            this.failing = false;
        } catch (error) {
            if (!this.failing) {
                this.options.onError?.(error);
            }
            this.failing = true;
        }
    }
}
