import { expect, test } from 'bun:test';

import { parseArgs, runBench } from './main';
import { summarize } from './stats';

test('the benchmark runs end to end with a tiny N', async () => {
    const report = await runBench(parseArgs(['--sizes', '3', '--argon2', '0,1', '--rtt', '1', '--uid-page', '2', '--distinct', '1']));
    expect(report).toContain('## Machine');
    expect(report).toMatch(/\| v4 \| 3 \|/);
    expect(report).toMatch(/\| v6-argon2 \| 3 \|/);
    expect(report).toMatch(/\| 3 \| 100% \|/);
}, 120_000);

test('either half can be skipped', async () => {
    const report = await runBench(parseArgs(['--skip', 'crypto', '--skip', 'listing']));
    expect(report).not.toContain('## Crypto');
    expect(report).not.toContain('## Listing');
});

test('flags are validated', () => {
    expect(() => parseArgs(['--bogus', '1'])).toThrow('Unknown flag');
    expect(() => parseArgs(['--rtt'])).toThrow('needs a value');
    expect(parseArgs(['--sizes', '5', '--rtt', '7', '--uid-page', '9']).listingSizes).toEqual([5]);
});

test('summaries give the spread', () => {
    expect(summarize([1, 2, 3, 4])).toMatchObject({ count: 4, mean: 2.5, min: 1, max: 4 });
    expect(() => summarize([])).toThrow();
});

test('the bench script prints the report', async () => {
    const run = Bun.spawn(['bun', `${import.meta.dir}/main.ts`, '--sizes', '2', '--argon2', '0.5', '--rtt', '1', '--distinct', '1'], {
        stdout: 'pipe',
        stderr: 'ignore',
    });
    const out = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    expect(out).toContain('## Listing');
}, 120_000);

test('the tree bench lists a nested tree cold, saves it, and lists it warm from the saved file without Drive calls', async () => {
    const report = await runBench(parseArgs(['--skip', 'crypto', '--skip', 'listing', '--tree-files', '30', '--tree-years', '2', '--rtt', '1', '--distinct', '1']));
    expect(report).toContain('## Tree');
    // 2 years of 12 months, plus My files, Photos, immich and the 2 year folders.
    expect(report).toMatch(/\| 30 \| 29 \|/);
    expect(report).toMatch(/\| warm \|[^\n]*\| 0 \| 0 \|/);
}, 120_000);

test('the stream bench reads a file of the fake Drive from the start and from a seek', async () => {
    const report = await runBench(parseArgs(['--skip', 'crypto', '--skip', 'listing', '--stream-mib', '9', '--block-ms', '1']));
    expect(report).toContain('## Stream');
    expect(report).toMatch(/\| from byte 1 to the end \| 9\.0 \|/);
    expect(report).toMatch(/\| seek to the middle, read to the end \| 4\.5 \|/);
});
