import type { Logger } from '@protontech/drive-sdk';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Logs to stderr. The SDK passes request URLs and errors here, never tokens,
 * but keep it that way: do not log headers or session objects.
 */
export function createLogger(minLevel: Level = parseLevel(process.env.PDM_LOG_LEVEL)): Logger {
    const write = (level: Level, message: string, extra: unknown[]) => {
        if (ORDER[level] < ORDER[minLevel]) {
            return;
        }
        const details = extra.map(formatExtra).filter(Boolean).join(' ');
        process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${details ? ` ${details}` : ''}\n`);
    };
    return {
        debug: (message: string, ...extra: unknown[]) => write('debug', message, extra),
        info: (message: string, ...extra: unknown[]) => write('info', message, extra),
        warn: (message: string, ...extra: unknown[]) => write('warn', message, extra),
        error: (message: string, ...extra: unknown[]) => write('error', message, extra),
    } as Logger;
}

export function silentLogger(): Logger {
    const noop = () => {};
    return { debug: noop, info: noop, warn: noop, error: noop } as Logger;
}

function parseLevel(value: string | undefined): Level {
    const lower = value?.toLowerCase();
    return lower === 'debug' || lower === 'warn' || lower === 'error' ? lower : 'info';
}

function formatExtra(value: unknown): string {
    if (value instanceof Error) {
        return `${value.name}: ${value.message}`;
    }
    if (value instanceof Response) {
        return `HTTP ${value.status}`;
    }
    if (value === undefined) {
        return '';
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Telemetry for the SDK: logs go to our logger, metrics are dropped (nothing is sent to Proton). */
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
