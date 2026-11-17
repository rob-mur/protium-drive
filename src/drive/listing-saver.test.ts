import { describe, expect, test } from 'bun:test';

import { LISTING_SAVE_INTERVAL_MS, ListingSaver } from './listing-saver.ts';

/** Timers the test fires by hand, in place of `setTimeout`. */
function manualTimers() {
    const timers = new Map<number, { callback: () => unknown; ms: number }>();
    let next = 1;
    return {
        setTimeout: (callback: () => unknown, ms: number) => {
            timers.set(next, { callback, ms });
            return next++;
        },
        clearTimeout: (handle: number) => void timers.delete(handle),
        pending: () => [...timers.values()].map((timer) => timer.ms),
        /** Fires every timer set so far, and waits for the work each one returns. */
        async fire() {
            const due = [...timers.entries()];
            for (const [handle] of due) timers.delete(handle);
            await Promise.all(due.map(([, timer]) => timer.callback()));
        },
    };
}

function setup(initialState: string | undefined) {
    const timers = manualTimers();
    const saves: string[] = [];
    let state = initialState;
    const saver = new ListingSaver({
        state: () => state,
        save: async () => {
            saves.push(state!);
        },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout as never,
    });
    return { saver, timers, saves, setState: (next: string | undefined) => (state = next) };
}

describe('ListingSaver', () => {
    test('saves at most a minute apart, so a kill loses at most a minute of listing work', () => {
        expect(LISTING_SAVE_INTERVAL_MS).toBeGreaterThan(0);
        expect(LISTING_SAVE_INTERVAL_MS).toBeLessThanOrEqual(60_000);
        const { saver, timers } = setup('listings-1');
        saver.start();
        expect(timers.pending()).toEqual([LISTING_SAVE_INTERVAL_MS]);
    });

    test('saves on each tick, then again on the next', async () => {
        const { saver, timers, saves, setState } = setup('listings-1');
        saver.start();
        await timers.fire();
        expect(saves).toEqual(['listings-1']);
        setState('listings-2');
        await timers.fire();
        expect(saves).toEqual(['listings-1', 'listings-2']);
        expect(timers.pending()).toEqual([LISTING_SAVE_INTERVAL_MS]);
    });

    test('does not write the file again while the listings have not changed', async () => {
        const { saver, timers, saves } = setup('listings-1');
        saver.start();
        await timers.fire();
        await timers.fire();
        await timers.fire();
        expect(saves).toEqual(['listings-1']);
    });

    test('saves nothing while there is nothing to save, and saves once there is', async () => {
        const { saver, timers, saves, setState } = setup(undefined);
        saver.start();
        await timers.fire();
        expect(saves).toEqual([]);
        setState('listings-1');
        await timers.fire();
        expect(saves).toEqual(['listings-1']);
    });

    test('a save that fails is tried again on the next tick', async () => {
        const timers = manualTimers();
        let attempts = 0;
        const saver = new ListingSaver({
            state: () => 'listings-1',
            save: async () => {
                attempts++;
                if (attempts === 1) throw new Error('disk full');
            },
            setTimeout: timers.setTimeout,
            clearTimeout: timers.clearTimeout as never,
        });
        saver.start();
        await timers.fire();
        await timers.fire();
        expect(attempts).toBe(2);
        await timers.fire();
        expect(attempts).toBe(2);
    });

    test('stop cancels the next tick and waits for a save in progress, so the final save never writes beside it', async () => {
        const timers = manualTimers();
        let finish!: () => void;
        let finished = false;
        const saver = new ListingSaver({
            state: () => 'listings-1',
            save: () =>
                new Promise<void>((resolve) => {
                    finish = () => {
                        finished = true;
                        resolve();
                    };
                }),
            setTimeout: timers.setTimeout,
            clearTimeout: timers.clearTimeout as never,
        });
        saver.start();
        const tick = timers.fire();
        let stopped = false;
        const stopping = saver.stop().then(() => (stopped = true));
        await Promise.resolve();
        expect(stopped).toBe(false);
        finish();
        await stopping;
        await tick;
        expect(finished).toBe(true);
        expect(timers.pending()).toEqual([]);
    });
});
