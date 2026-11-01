import type { Logger } from '../vendor/proton-drive-sdk-account';

/** Levels below the threshold go nowhere; the rest go to stderr, so stdout stays for answers. */
export function createLogger(env: NodeJS.ProcessEnv = process.env): Logger {
    const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
    const threshold = levels[(env.PDM_LOG_LEVEL ?? 'info') as keyof typeof levels] ?? levels.info;
    const write = (level: keyof typeof levels) => (message: string, ...args: unknown[]) => {
        if (levels[level] < threshold) return;
        const rest = args.length ? ` ${args.map(String).join(' ')}` : '';
        process.stderr.write(`${level}: ${message}${rest}\n`);
    };
    return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
