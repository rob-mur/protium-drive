import type { WebDavHandler } from './handler';

/** Large enough for any single file; PUT bodies stream, so this is a limit, not a buffer. */
const MAX_REQUEST_BODY_BYTES = 1024 ** 4;

export type ServerOptions = {
    host: string;
    port: number;
    handler: WebDavHandler;
};

export type RunningServer = {
    url: URL;
    port: number;
    stop(): Promise<void>;
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
        stop: () => server.stop(true),
    };
}
