import os from 'node:os';

import { stopCryptoWorker } from '../src/proton/crypto-pool';

import { benchCrypto, type CryptoRow } from './crypto';
import { benchListing, type ListingRow } from './listing';
import { fixed, table } from './stats';

export type BenchOptions = {
    sizes: number[];
    listingSizes: number[];
    argon2Fractions: number[];
    roundTripMs: number;
    uidPage: number;
    distinctKeys: number;
    skip: Set<'crypto' | 'listing'>;
};

export const DEFAULTS: BenchOptions = {
    sizes: [30, 300, 3000],
    listingSizes: [30, 300, 3000],
    argon2Fractions: [0, 0.1, 1],
    roundTripMs: 100,
    uidPage: 150,
    distinctKeys: 16,
    skip: new Set(),
};

const numbers = (value: string) => value.split(',').map(Number);

/** Reads `--sizes 30,300 --argon2 0,1 --rtt 100 --uid-page 150 --distinct 16 --skip crypto|listing`. */
export function parseArgs(argv: string[]): BenchOptions {
    const options: BenchOptions = { ...DEFAULTS, skip: new Set() };
    for (let i = 0; i < argv.length; i += 2) {
        const [flag, value] = [argv[i], argv[i + 1]];
        if (value === undefined) {
            throw new Error(`${flag} needs a value`);
        }
        switch (flag) {
            case '--sizes':
                options.sizes = options.listingSizes = numbers(value);
                break;
            case '--argon2':
                options.argon2Fractions = numbers(value);
                break;
            case '--rtt':
                options.roundTripMs = Number(value);
                break;
            case '--uid-page':
                options.uidPage = Number(value);
                break;
            case '--distinct':
                options.distinctKeys = Number(value);
                break;
            case '--skip':
                options.skip.add(value as 'crypto' | 'listing');
                break;
            default:
                throw new Error(`Unknown flag ${flag}`);
        }
    }
    return options;
}

function machine(): string {
    const cpus = os.cpus();
    return [
        `cpu: ${cpus[0]?.model ?? 'unknown'} x${cpus.length}`,
        `memory: ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB`,
        `os: ${os.type()} ${os.release()}`,
        `bun: ${Bun.version}`,
    ].join('\n');
}

export function cryptoReport(rows: CryptoRow[]): string {
    return table(
        ['key kind', 'keys', 'per key mean ms', 'stdev', 'p50', 'p95', 'min', 'max', 'one at a time s', 'all at once s', 'once/at-a-time'],
        rows.map((r) => [
            r.kind,
            String(r.keys),
            fixed(r.perKey.mean),
            fixed(r.perKey.stdev),
            fixed(r.perKey.p50),
            fixed(r.perKey.p95),
            fixed(r.perKey.min),
            fixed(r.perKey.max),
            (r.sequentialMs / 1000).toFixed(2),
            (r.concurrentMs / 1000).toFixed(2),
            (r.concurrentMs / r.sequentialMs).toFixed(2),
        ]),
    );
}

export function listingReport(rows: ListingRow[]): string {
    return table(
        ['files', 'argon2', 'UID drain ms', 'node iteration ms', '(round trips)', '(crypto)', 'tree other ms', '(toEntry alone)', 'tree.list ms', 'cached list ms', 'XML ms', 'XML KiB', 'total ms'],
        rows.map((r) => [
            String(r.files),
            `${Math.round(r.argon2Fraction * 100)}%`,
            fixed(r.uidDrainMs),
            fixed(r.nodeIterationMs),
            fixed(r.nodeRoundTripMs),
            fixed(r.nodeCryptoMs),
            fixed(r.treeOtherMs),
            fixed(r.toEntryMs),
            fixed(r.listMs),
            fixed(r.cachedListMs),
            fixed(r.xmlMs),
            (r.xmlBytes / 1024).toFixed(0),
            fixed(r.totalMs),
        ]),
    );
}

/** Runs the benchmark and returns its Markdown report. It measures and never judges: no time fails it. */
export async function runBench(options: BenchOptions, log: (text: string) => void = () => {}): Promise<string> {
    const parts = [`## Machine\n\n\`\`\`\n${machine()}\n\`\`\``];
    try {
        if (!options.skip.has('crypto')) {
            log('crypto...');
            parts.push(`## Crypto: CryptoProxy.importPrivateKey through the crypto worker (${options.distinctKeys} distinct keys per kind, repeated)\n\n${cryptoReport(await benchCrypto(options.sizes, ['v4', 'v6-argon2'], options.distinctKeys))}`);
        }
        if (!options.skip.has('listing')) {
            log('listing...');
            const { roundTripMs, uidPage, distinctKeys } = options;
            const rows = await benchListing(options.listingSizes, options.argon2Fractions, { roundTripMs, uidPage, distinctKeys });
            parts.push(`## Listing: simulated round trip ${roundTripMs} ms, ${uidPage} UIDs per page, ${30} nodes per batch\n\n${listingReport(rows)}`);
        }
    } finally {
        await stopCryptoWorker();
    }
    return parts.join('\n\n');
}

if (import.meta.main) {
    console.log(await runBench(parseArgs(Bun.argv.slice(2)), (text) => console.error(text)));
}
