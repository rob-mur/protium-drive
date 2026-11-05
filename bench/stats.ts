/** Summary of a list of timings in milliseconds. */
export type Summary = { count: number; mean: number; stdev: number; min: number; p50: number; p95: number; max: number };

export function summarize(samples: number[]): Summary {
    if (samples.length === 0) {
        throw new Error('Nothing to summarise');
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const mean = samples.reduce((sum, x) => sum + x, 0) / samples.length;
    const variance = samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / samples.length;
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { count: samples.length, mean, stdev: Math.sqrt(variance), min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

/** Runs `work` and gives back the milliseconds it took with its result. */
export async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
    const start = performance.now();
    const value = await work();
    return { ms: performance.now() - start, value };
}

export const fixed = (ms: number): string => ms.toFixed(ms < 10 ? 2 : ms < 1000 ? 1 : 0);

/** A GitHub-flavoured Markdown table. */
export function table(header: string[], rows: string[][]): string {
    const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
    return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}
