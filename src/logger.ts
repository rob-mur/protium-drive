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

/** Levels below `level` go nowhere; the rest go to stderr, so stdout stays for answers. */
export function createLogger(level: LogLevel = 'info'): Logger {
    const threshold = LOG_LEVELS.indexOf(level);
    const write = (at: LogLevel) => (message: string, ...args: unknown[]) => {
        if (LOG_LEVELS.indexOf(at) < threshold) return;
        const rest = args.length ? ` ${args.map(String).join(' ')}` : '';
        process.stderr.write(`${at}: ${message}${rest}\n`);
    };
    return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

/**
 * Telemetry for the SDK: logs go to our logger, metrics are dropped (nothing
 * is sent to Proton).
 */
export function createTelemetry(logger: Logger) {
    return {
        getLogger: (name: string): Logger => ({
            debug: (message: string) => logger.debug(`[${name}] ${message}`),
            info: (message: string) => logger.info(`[${name}] ${message}`),
            warn: (message: string) => logger.warn(`[${name}] ${message}`),
            error: (message: string, error?: unknown) => logger.error(`[${name}] ${message}`, error),
        }),
        recordMetric: () => {},
    };
}
