/** An error that maps to one HTTP status. The WebDAV layer sends `status` and `message`. */
export class DriveError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly retryAfterSeconds?: number,
    ) {
        super(message);
        this.name = 'DriveError';
    }
}

export const notFound = (what: string) => new DriveError(404, `${what} not found`);
export const conflict = (message: string) => new DriveError(409, message);
