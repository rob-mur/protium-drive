import type { WebDavHandler } from './handler';

/** Large enough for any single file; PUT bodies stream, so this is a limit, not a buffer. */
const MAX_REQUEST_BODY_BYTES = 1024 ** 4;

export const GRACEFUL_STOP_MS = 5_000;

export type ServerOptions = {
    host: string;
    port: number;
    handler: WebDavHandler;
};

export type RunningServer = {
    url: URL;
    port: number;
    /** `graceful`: let the requests in flight finish, for at most GRACEFUL_STOP_MS. */
    stop(graceful?: boolean): Promise<void>;
};

export function startServer(options: ServerOptions): RunningServer {
    const server = Bun.serve({
        hostname: options.host,
        port: options.port,
        // Bun's default limit is 128 MiB, which would cut large uploads.
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        // Uploads and downloads of large files can be quiet for a while.
        idleTimeout: 0,
        fetch: options.handler,
    });
    return {
        url: server.url,
        port: server.port ?? options.port,
        stop: async (graceful = false) => {
            if (graceful) {
                const finished = await Promise.race([
                    server.stop(false).then(() => true),
                    new Promise<false>((resolve) => setTimeout(resolve, GRACEFUL_STOP_MS, false)),
                ]);
                if (finished) return;
            }
            await server.stop(true);
        },
    };
}
