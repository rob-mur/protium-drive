import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeClock } from './clock.ts';
import { FakeDrive, FakeDriveClient, SCOPE_ID } from './drive.ts';

describe('the clock', () => {
    test('starts at the time it is given, and stands still until it is moved', async () => {
        const clock = new FakeClock(1_000_000);
        expect(clock.now()).toBe(1_000_000);
        await Bun.sleep(5);
        expect(clock.now()).toBe(1_000_000);
        expect(await clock.advance(30_000)).toEqual({ now: 1_030_000, fired: 0 });
        expect(clock.now()).toBe(1_030_000);
    });

    test('by default it starts at the real time', () => {
        const before = Date.now();
        const now = new FakeClock().now();
        expect(now).toBeGreaterThanOrEqual(before);
        expect(now).toBeLessThanOrEqual(Date.now());
    });

    test('fires each timer that falls due in the span, in due order and at its due time, and no other', async () => {
        const clock = new FakeClock(0);
        const fired: Array<[string, number]> = [];
        clock.setTimeout(() => fired.push(['b', clock.now()]), 20_000);
        clock.setTimeout(() => fired.push(['a', clock.now()]), 10_000);
        clock.setTimeout(() => fired.push(['c', clock.now()]), 30_001);

        expect(await clock.advance(30_000)).toEqual({ now: 30_000, fired: 2 });
        expect(fired).toEqual([
            ['a', 10_000],
            ['b', 20_000],
        ]);

        expect(await clock.advance(1)).toEqual({ now: 30_001, fired: 1 });
        expect(fired.at(-1)).toEqual(['c', 30_001]);
        expect(await clock.advance(60_000)).toEqual({ now: 90_001, fired: 0 });
    });

    test('a timer that a fired timer sets fires too when it falls due in the same span', async () => {
        const clock = new FakeClock(0);
        const fired: number[] = [];
        const poll = async () => {
            fired.push(clock.now());
            await Promise.resolve();
            clock.setTimeout(() => void poll(), 30_000);
        };
        clock.setTimeout(() => void poll(), 30_000);

        expect(await clock.advance(95_000)).toEqual({ now: 95_000, fired: 3 });
        expect(fired).toEqual([30_000, 60_000, 90_000]);
    });

    test('a timer callback that waits on a second timer completes in one move', async () => {
        const clock = new FakeClock(0);
        const done: number[] = [];
        clock.setTimeout(async () => {
            await new Promise<void>((resolve) => clock.setTimeout(resolve, 1_000));
            done.push(clock.now());
        }, 1_000);

        expect(await clock.advance(5_000)).toEqual({ now: 5_000, fired: 2 });
        expect(done).toEqual([2_000]);
    });

    test('a cleared timer never fires, and a timer of 0 ms or less fires on the next move', async () => {
        const clock = new FakeClock(0);
        const fired: string[] = [];
        const handle = clock.setTimeout(() => fired.push('cleared'), 1_000);
        clock.setTimeout(() => fired.push('now'), -5);
        clock.clearTimeout(handle);
        clock.clearTimeout(handle);

        expect(await clock.advance(0)).toEqual({ now: 0, fired: 1 });
        expect(await clock.advance(5_000)).toEqual({ now: 5_000, fired: 0 });
        expect(fired).toEqual(['now']);
    });

    test('a timer of a negative delay fires on the next move, with now() at the time of the move', async () => {
        const clock = new FakeClock(1_000);
        const seen: number[] = [];
        clock.setTimeout(() => seen.push(clock.now()), -500);
        expect(await clock.advance(0)).toEqual({ now: 1_000, fired: 1 });
        expect(seen).toEqual([1_000]);
    });

    test('a timer of a delay that is not a number fires on the next move, as with a real timer', async () => {
        const clock = new FakeClock(0);
        const seen: number[] = [];
        clock.setTimeout(() => seen.push(clock.now()), Number.NaN);
        clock.setTimeout(() => seen.push(clock.now()), 'soon' as unknown as number);
        expect(clock.pending()).toEqual([0, 0]);
        expect(await clock.advance(0)).toEqual({ now: 0, fired: 2 });
        expect(seen).toEqual([0, 0]);
    });

    test('timers that fall due at one time fire in the order they were set', async () => {
        const clock = new FakeClock(0);
        const fired: string[] = [];
        for (const name of ['first', 'second', 'third']) clock.setTimeout(() => fired.push(name), 1_000);
        await clock.advance(1_000);
        expect(fired).toEqual(['first', 'second', 'third']);
    });

    test('a move resolves only once the work of each timer it fired ends, real I/O included', async () => {
        const clock = new FakeClock(0);
        let done = false;
        clock.setTimeout(async () => {
            await Bun.sleep(5);
            done = true;
        }, 1_000);
        await clock.advance(1_000);
        expect(done).toBe(true);
    });

    test('two moves that overlap run one after the other, and the clock never moves back', async () => {
        const clock = new FakeClock(0);
        for (let second = 1; second <= 5; second++) clock.setTimeout(() => {}, second * 1_000);
        const seen: number[] = [];
        const watch = setInterval(() => seen.push(clock.now()), 0);
        try {
            const a = clock.advance(5_000);
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            const b = clock.advance(60_000);
            const [first, second] = await Promise.all([a, b]);
            expect(first).toEqual({ now: 5_000, fired: 5 });
            expect(second).toEqual({ now: 65_000, fired: 0 });
            expect(clock.now()).toBe(65_000);
            seen.push(clock.now());
            expect(seen).toEqual([...seen].sort((x, y) => x - y));
        } finally {
            clearInterval(watch);
        }
    });

    test('a timer that throws does not stop the others', async () => {
        const clock = new FakeClock(0);
        const fired: string[] = [];
        clock.setTimeout(() => {
            throw new Error('boom');
        }, 1);
        clock.setTimeout(async () => {
            throw new Error('async boom');
        }, 2);
        clock.setTimeout(() => fired.push('after'), 3);
        expect(await clock.advance(10)).toEqual({ now: 10, fired: 3 });
        expect(fired).toEqual(['after']);
    });

    test('refuses a move by a negative or non-finite span', async () => {
        const clock = new FakeClock(0);
        await expect(clock.advance(-1)).rejects.toThrow(RangeError);
        await expect(clock.advance(Number.NaN)).rejects.toThrow(RangeError);
        await expect(clock.advance(Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError);
        expect(clock.now()).toBe(0);
    });

    test('lists the due times of the timers still pending', async () => {
        const clock = new FakeClock(0);
        clock.setTimeout(() => {}, 60_000);
        clock.setTimeout(() => {}, 30_000);
        expect(clock.pending()).toEqual([30_000, 60_000]);
        await clock.advance(30_000);
        expect(clock.pending()).toEqual([60_000]);
    });
});

describe("the Drive's event scheduler on the clock", () => {
    test('polls when a scope is added, then each time 30 seconds pass after its last poll ends', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fake-drive-clock-'));
        try {
            const clock = new FakeClock(0);
            const client = new FakeDriveClient(FakeDrive.open(dir), { clock });
            const polls: number[] = [];
            const scheduler = await client.getEventScheduler(async () => void polls.push(clock.now()));
            scheduler.addScope(SCOPE_ID);
            await clock.advance(0);
            expect(polls).toEqual([0]);

            await clock.advance(29_999);
            expect(polls).toEqual([0]);
            await clock.advance(1);
            expect(polls).toEqual([0, 30_000]);

            await clock.advance(10_000);
            expect(await client.fireEventScheduler()).toEqual([SCOPE_ID]);
            await clock.advance(29_999);
            expect(polls).toEqual([0, 30_000, 40_000]);
            await clock.advance(1);
            expect(polls).toEqual([0, 30_000, 40_000, 70_000]);

            scheduler.removeScope(SCOPE_ID);
            await clock.advance(120_000);
            expect(polls).toHaveLength(4);
            expect(clock.pending()).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a poll that awaits real file I/O still polls every 30 seconds in one move', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fake-drive-clock-'));
        try {
            const clock = new FakeClock(0);
            const client = new FakeDriveClient(FakeDrive.open(dir), { clock });
            const polls: number[] = [];
            let writing = false;
            const scheduler = await client.getEventScheduler(async () => {
                polls.push(clock.now());
                writing = true;
                await writeFile(join(dir, 'poll.txt'), String(clock.now()));
                writing = false;
            });
            scheduler.addScope(SCOPE_ID);
            expect(await clock.advance(90_000)).toEqual({ now: 90_000, fired: 3 });
            expect(polls).toEqual([0, 30_000, 60_000, 90_000]);
            expect(writing).toBe(false);
            expect(clock.pending()).toEqual([120_000]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a fire while a timed poll runs waits for it: two polls never overlap', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fake-drive-clock-'));
        try {
            const clock = new FakeClock(0);
            const client = new FakeDriveClient(FakeDrive.open(dir), { clock });
            let running = 0;
            let most = 0;
            // Each poll waits until the test lets it end.
            const gates: Array<() => void> = [];
            const scheduler = await client.getEventScheduler(async () => {
                most = Math.max(most, ++running);
                await new Promise<void>((resolve) => gates.push(resolve));
                running--;
            });
            const polls = async (count: number) => {
                while (gates.length < count) await Bun.sleep(1);
            };
            scheduler.addScope(SCOPE_ID);
            const move = clock.advance(30_000);
            gates[0]!();
            await polls(2);
            const fire = client.fireEventScheduler();
            await Bun.sleep(5);
            expect(gates).toHaveLength(2);
            gates[1]!();
            await polls(3);
            gates[2]!();
            expect(await fire).toEqual([SCOPE_ID]);
            await move;
            expect(most).toBe(1);
            expect(gates).toHaveLength(3);
            // The fire set the one next timer, 30 s after it ended.
            expect(clock.pending()).toEqual([60_000]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a fire resets the timer: the next timed poll is 30 seconds after the fire, and there is one timer only', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fake-drive-clock-'));
        try {
            const clock = new FakeClock(0);
            const client = new FakeDriveClient(FakeDrive.open(dir), { clock });
            const polls: number[] = [];
            const scheduler = await client.getEventScheduler(async () => void polls.push(clock.now()));
            scheduler.addScope(SCOPE_ID);
            await clock.advance(10_000);
            await client.fireEventScheduler();
            expect(clock.pending()).toEqual([40_000]);
            await clock.advance(30_000);
            expect(polls).toEqual([0, 10_000, 40_000]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a scope removed while its poll runs gets no new timer', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fake-drive-clock-'));
        try {
            const clock = new FakeClock(0);
            const client = new FakeDriveClient(FakeDrive.open(dir), { clock });
            let release!: () => void;
            const scheduler = await client.getEventScheduler(() => new Promise<void>((resolve) => (release = resolve)));
            scheduler.addScope(SCOPE_ID);
            scheduler.removeScope(SCOPE_ID);
            release();
            await Bun.sleep(1);
            expect(clock.pending()).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('with no clock, it polls only when fired, as before', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fake-drive-clock-'));
        try {
            const clock = new FakeClock(0);
            const client = new FakeDriveClient(FakeDrive.open(dir));
            let polls = 0;
            const scheduler = await client.getEventScheduler(async () => void polls++);
            scheduler.addScope(SCOPE_ID);
            await clock.advance(600_000);
            expect(polls).toBe(1);
            expect(clock.pending()).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
