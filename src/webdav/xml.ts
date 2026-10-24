import type { Entry } from '../drive/entry';

import { toHref } from './paths';

export function escapeXml(value: string): string {
    return value.replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '&':
                return '&amp;';
            case "'":
                return '&apos;';
            default:
                return '&quot;';
        }
    });
}

/** Strong ETag for a file revision, or a weak one for folders. */
export function etagFor(entry: Entry): string {
    if (entry.kind === 'file') {
        return `"${entry.revisionUid ?? entry.uid}"`;
    }
    return `W/"${entry.uid}-${entry.modified.getTime()}"`;
}

/** One `<D:response>` with the live properties rclone and other clients read. */
function propResponse(segments: string[], entry: Entry): string {
    const props = [
        `<D:displayname>${escapeXml(entry.name)}</D:displayname>`,
        `<D:getlastmodified>${entry.modified.toUTCString()}</D:getlastmodified>`,
        `<D:creationdate>${entry.created.toISOString()}</D:creationdate>`,
        `<D:getetag>${escapeXml(etagFor(entry))}</D:getetag>`,
    ];
    if (entry.kind === 'folder') {
        props.push('<D:resourcetype><D:collection/></D:resourcetype>');
    } else {
        props.push(
            '<D:resourcetype/>',
            `<D:getcontentlength>${entry.size}</D:getcontentlength>`,
            `<D:getcontenttype>${escapeXml(entry.mediaType ?? 'application/octet-stream')}</D:getcontenttype>`,
        );
    }
    return [
        '<D:response>',
        `<D:href>${escapeXml(toHref(segments, entry.kind === 'folder'))}</D:href>`,
        '<D:propstat>',
        `<D:prop>${props.join('')}</D:prop>`,
        '<D:status>HTTP/1.1 200 OK</D:status>',
        '</D:propstat>',
        '</D:response>',
    ].join('');
}

/** Builds a PROPFIND multistatus body: the target first, then its children. */
export function multistatus(segments: string[], target: Entry, children: Entry[]): string {
    const responses = [propResponse(segments, target)];
    for (const child of children) {
        responses.push(propResponse([...segments, child.name], child));
    }
    return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join('\n')}</D:multistatus>\n`;
}
