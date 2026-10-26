/**
 * The Receive arm's clock: the `now()` and the timers the product takes under `--fake-drive`, in
 * place of `Date.now`, `setTimeout` and `clearTimeout`. The product's 429 back-off, its 60 s guard
 * after a failed overwrite, its event-watcher retry and the Drive's event scheduler all read it.
 *
 * Time stands still until the control channel moves it (`POST /clock/advance`). A move fires,
 * in due order, every timer that falls due in the span, each with `now()` at its due time, and
 * ends once the work of the fired timers ends. The clock lives in memory: each process starts it
 * at the real time. It never touches the real clock, so nothing changes without the switch.
 */

/** The time and the timers the product takes. Without the switch, the product uses the real ones. */
export type Clock = {
    /** Milliseconds since the epoch, as `Date.now()`. */
    now(): number;
    setTimeout(callback: () => unknown, ms: number): TimerHandle;
    clearTimeout(handle: TimerHandle | undefined): void;
};

export type TimerHandle = { readonly timer: number };

type Timer = { id: number; due: number; callback: () => unknown };

export class FakeClock implements Clock {
    private time: number;
    private nextId = 1;
    private readonly timers = new Map<number, Timer>();
    /** The work a move waits for: the fired callbacks, and what `track` hands in. */
    private readonly busy = new Set<Promise<unknown>>();
    /** Wakes a move that waits on `busy` when a timer is set. */
    private timerSet?: () => void;
    /** The move in progress, so that a second move starts only after it ends. */
    private moving: Promise<unknown> = Promise.resolve();

    constructor(start: number = Date.now()) {
        this.time = start;
    }

    now(): number {
        return this.time;
    }

    /** As the real `setTimeout`, a delay that is not a positive number counts as 0. */
    setTimeout(callback: () => unknown, ms: number): TimerHandle {
        const id = this.nextId++;
        const delay = Number(ms);
        this.timers.set(id, { id, due: this.time + (delay > 0 && Number.isFinite(delay) ? delay : 0), callback });
        this.timerSet?.();
        return { timer: id };
    }

    clearTimeout(handle: TimerHandle | undefined): void {
        if (handle) this.timers.delete(handle.timer);
    }

    /** The due times of the timers that have not fired, earliest first. */
    pending(): number[] {
        return [...this.timers.values()].map((timer) => timer.due).sort((a, b) => a - b);
    }

    /**
     * Hands the clock work that runs outside a timer (the event scheduler's first poll, or a poll
     * that a fire starts). A move waits for it as for a fired callback.
     */
    track(work: Promise<unknown>): void {
        const held = work.then(
            () => {},
            () => {},
        );
        this.busy.add(held);
        void held.then(() => this.busy.delete(held));
    }

    /**
     * Moves the clock on by `ms` and fires each timer that falls due, a timer that a fired one sets
     * included. Before it picks the next timer, it waits for the work of each fired callback (and
     * of `track`) to end, or to set a timer: a callback that waits on a second timer would wait
     * for ever, since only this move can fire that timer. A move that starts while another runs
     * starts when that one ends, so the clock never moves back.
     */
    advance(ms: number): Promise<{ now: number; fired: number }> {
        if (!Number.isFinite(ms) || ms < 0) return Promise.reject(new RangeError(`fake-drive: the clock cannot move by ${ms} ms`));
        const move = this.moving.then(() => this.move(ms));
        this.moving = move.catch(() => {});
        return move;
    }

    private async move(ms: number): Promise<{ now: number; fired: number }> {
        const end = this.time + ms;
        let fired = 0;
        for (;;) {
            await this.idle();
            const next = this.nextDue(end);
            if (!next) break;
            this.timers.delete(next.id);
            this.time = next.due;
            fired++;
            // A timer that throws is the product's error to handle, as with a real timer.
            this.track(Promise.resolve().then(next.callback));
        }
        this.time = end;
        return { now: this.time, fired };
    }

    /** Waits until the work in `busy` ends or a timer is set, then lets queued promise work run. */
    private async idle(): Promise<void> {
        while (this.busy.size > 0) {
            const timerSet = new Promise<'timer'>((resolve) => (this.timerSet = () => resolve('timer')));
            const outcome = await Promise.race([Promise.all([...this.busy]), timerSet]);
            this.timerSet = undefined;
            // The work that set a timer may wait on it; the move goes on and no longer waits for it.
            if (outcome === 'timer') this.busy.clear();
        }
        await settle();
    }

    private nextDue(end: number): Timer | undefined {
        let next: Timer | undefined;
        for (const timer of this.timers.values()) {
            if (timer.due <= end && (!next || timer.due < next.due)) next = timer;
        }
        return next;
    }
}

/** Lets queued promise work run, as the event loop would between two real timers. */
function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}
