import { DriveError } from '../drive/errors';

/**
 * Splits a URL path into decoded segments. Rejects segments that a file name
 * on Proton Drive cannot be (`.`, `..`, or names with `/` or NUL after
 * decoding).
 */
export function parsePath(pathname: string): string[] {
    const segments: string[] = [];
    for (const raw of pathname.split('/')) {
        if (raw === '') {
            continue;
        }
        let segment: string;
        try {
            segment = decodeURIComponent(raw);
        } catch {
            throw new DriveError(400, `Bad percent-encoding in path segment ${raw}`);
        }
        if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\0')) {
            throw new DriveError(400, `Bad path segment ${JSON.stringify(segment)}`);
        }
        segments.push(segment);
    }
    return segments;
}

/** Builds the `href` for an entry. Folders end with `/`, as WebDAV clients expect. */
export function toHref(segments: string[], isFolder: boolean): string {
    const path = segments.map(encodeSegment).join('/');
    if (path === '') {
        return '/';
    }
    return `/${path}${isFolder ? '/' : ''}`;
}

/** Percent-encodes everything except unreserved characters and a few safe sub-delims. */
function encodeSegment(segment: string): string {
    return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
