import { type App, startApp } from '../../src/app';
import { silentLogger } from '../../src/logger';
import { FakeDriveSdk } from './fakeSdk';

export type Harness = {
    fake: FakeDriveSdk;
    app: App;
    url: (path?: string) => string;
    stop: () => Promise<void>;
};

/** Starts the real server, on a free loopback port, over a `FakeDriveSdk`. */
export function startHarness(options: { root?: string; authProblem?: () => string | undefined; fake?: FakeDriveSdk } = {}): Harness {
    const fake = options.fake ?? new FakeDriveSdk();
    const app = startApp({
        sdk: fake,
        logger: silentLogger(),
        host: '127.0.0.1',
        port: 0,
        root: options.root,
        authProblem: options.authProblem,
        watchEvents: false,
    });
    const base = app.server.url.href.replace(/\/$/, '');
    return {
        fake,
        app,
        url: (path = '/') => `${base}${path}`,
        stop: () => app.stop(),
    };
}

/** Waits until a condition holds, for stream cleanup that finishes after the response. */
export async function eventually(check: () => boolean, timeoutMs = 2000): Promise<void> {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('condition not met in time');
        }
        await Bun.sleep(10);
    }
}
