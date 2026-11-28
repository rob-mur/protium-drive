import { AsyncLocalStorage } from 'node:async_hooks';

import { AbortError } from '@protontech/drive-sdk';

import type { Logger } from '../vendor/proton-drive-sdk-account';

/** The levels a user can log at, lowest first. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: string): value is LogLevel {
    return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * The level from --log-level, else from PDM_LOG_LEVEL, else info; or a message that names the
 * value that is not a level and where it came from.
 */
export function logLevel(flag: string | undefined, env: NodeJS.ProcessEnv): LogLevel | string {
    const [source, value] = flag !== undefined ? ['--log-level', flag] : ['PDM_LOG_LEVEL', env.PDM_LOG_LEVEL];
    if (value === undefined) return 'info';
    if (isLogLevel(value)) return value;
    return `Bad ${source} ${JSON.stringify(value)}: give debug, info, warn or error.`;
}

const NAMED_ESCAPES: Record<string, string> = { '\r': '\\r', '\n': '\\n', '\t': '\\t' };

/**
 * Writes C0 and C1 control characters, DEL and the Unicode line and paragraph separators as escapes.
 * Logged values can come from the Drive or a client, so a CR or LF in one must not start a forged
 * log line.
 */
function escapeControls(line: string): string {
    return line.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (char) => {
        const code = char.charCodeAt(0);
        return NAMED_ESCAPES[char] ?? (code > 0xff ? `\\u${code.toString(16)}` : `\\x${code.toString(16).padStart(2, '0')}`);
    });
}

/** Levels below `level` go nowhere; the rest go to stderr, so stdout stays for answers. */
export function createLogger(level: LogLevel = 'info'): Logger {
    const threshold = LOG_LEVELS.indexOf(level);
    const write = (at: LogLevel) => (message: string, ...args: unknown[]) => {
        if (LOG_LEVELS.indexOf(at) < threshold) return;
        const rest = args.length ? ` ${args.map(String).join(' ')}` : '';
        process.stderr.write(`${at}: ${escapeControls(`${message}${rest}`)}\n`);
    };
    return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

/** For the upload that the code running now does, if any: a signal that aborts when its client drops it. */
const uploadRequest = new AsyncLocalStorage<AbortSignal | undefined>();

/**
 * Runs `upload` with `signal` as the client abort of each SDK line it logs. The signal must abort only
 * when the client dropped the upload before pdm aborted it, so a client that goes away after a stall
 * does not make the stall a warning.
 */
export function withUploadRequest<T>(signal: AbortSignal | undefined, upload: () => Promise<T>): Promise<T> {
    return uploadRequest.run(signal, upload);
}

/**
 * Telemetry for the SDK: logs go to our logger, metrics are dropped (nothing
 * is sent to Proton). An SDK error that is an `AbortError` in an upload whose client request
 * aborted goes to warn: the client dropped the PUT (as rclone does at stop) and will send the
 * file again, so it is not a failure of ours. A stall abort does not abort that signal, so it stays
 * an error.
 */
export function createTelemetry(logger: Logger) {
    return {
        getLogger: (name: string): Logger => ({
            debug: (message: string) => logger.debug(`[${name}] ${message}`),
            info: (message: string) => logger.info(`[${name}] ${message}`),
            warn: (message: string) => logger.warn(`[${name}] ${message}`),
            error: (message: string, error?: unknown) => {
                const clientAborted = error instanceof AbortError && uploadRequest.getStore()?.aborted === true;
                if (clientAborted) logger.warn(`[${name}] ${message}`, error);
                else logger.error(`[${name}] ${message}`, error);
            },
        }),
        recordMetric: () => {},
    };
}
