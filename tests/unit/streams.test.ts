import { describe, expect, test } from 'bun:test';

import { primeStream, sliceStream } from '../../src/drive/download';
import { parseRange } from '../../src/webdav/handler';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
}

describe('parseRange', () => {
    test('parses the single-range forms', () => {
        expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
        expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
        expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    });

    test('serves a full body for no range or forms it does not support', () => {
        expect(parseRange(null, 100)).toBeUndefined();
        expect(parseRange('bytes=0-1,5-6', 100)).toBeUndefined();
        expect(parseRange('items=0-1', 100)).toBeUndefined();
    });

    test('reports ranges outside the file', () => {
        expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
        expect(parseRange('bytes=5-4', 100)).toBe('unsatisfiable');
        expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
        expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    });
});

describe('sliceStream', () => {
    test('cuts a range across chunk borders', async () => {
        const sliced = sliceStream(streamOf(['abc', 'def', 'ghi']), 2, 6);
        expect(await new Response(sliced).text()).toBe('cdefg');
    });

    test('handles a range inside one chunk and at the end', async () => {
        expect(await new Response(sliceStream(streamOf(['abcdef']), 1, 2)).text()).toBe('bc');
        expect(await new Response(sliceStream(streamOf(['ab', 'cd']), 3, 10)).text()).toBe('d');
    });
});

describe('primeStream', () => {
    test('keeps every chunk', async () => {
        const primed = await primeStream(streamOf(['a', 'b', 'c']));
        expect(await new Response(primed).text()).toBe('abc');
    });

    test('rejects when the source fails before the first chunk', async () => {
        const failing = new ReadableStream<Uint8Array>({
            pull() {
                throw new Error('integrity failure');
            },
        });
        const abort = new AbortController();
        await expect(primeStream(failing, abort)).rejects.toThrow('integrity failure');
        expect(abort.signal.aborted).toBe(true);
    });
});
