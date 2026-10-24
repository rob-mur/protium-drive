import type { Logger } from '@protontech/drive-sdk';

import { EventWatcher } from './drive/events';
import type { DriveSdk } from './drive/sdk';
import { DriveTree } from './drive/tree';
import { createWebDavHandler } from './webdav/handler';
import { parsePath } from './webdav/paths';
import { type RunningServer, startServer } from './webdav/server';

export type AppOptions = {
    sdk: DriveSdk;
    logger: Logger;
    host: string;
    port: number;
    /** Folder inside My files to serve as `/`, for example `Photos/immich`. */
    root?: string;
    authProblem?: () => string | undefined;
    /** Read Drive events to keep the cache fresh. On by default. */
    watchEvents?: boolean;
};

export type App = {
    tree: DriveTree;
    server: RunningServer;
    stop(): Promise<void>;
};

const WATCHER_RETRY_MS = 60_000;

/** Builds the tree, the event watcher and the WebDAV server on top of any `DriveSdk`. */
export function startApp(options: AppOptions): App {
    const { sdk, logger } = options;
    const tree = new DriveTree(sdk, logger, { rootPath: options.root ? parsePath(options.root) : [] });
    const handler = createWebDavHandler({ tree, logger, authProblem: options.authProblem });
    const server = startServer({ host: options.host, port: options.port, handler });

    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const watcher = new EventWatcher(sdk, tree, logger, () => !options.authProblem?.());
    const startWatcher = () => {
        if (stopped) {
            return;
        }
        if (options.authProblem?.()) {
            retryTimer = setTimeout(startWatcher, WATCHER_RETRY_MS);
            return;
        }
        watcher.start().catch((error: unknown) => {
            logger.warn(`Cannot start the Drive event watcher yet: ${String(error)}`);
            if (!stopped) {
                retryTimer = setTimeout(startWatcher, WATCHER_RETRY_MS);
            }
        });
    };
    if (options.watchEvents !== false) {
        startWatcher();
    }

    return {
        tree,
        server,
        async stop() {
            stopped = true;
            clearTimeout(retryTimer);
            watcher.stop();
            await server.stop();
        },
    };
}
