import type { Entry } from '../drive/entry';

import { toHref } from './paths';

/**
 * Characters outside the XML 1.0 `Char` production: C0 controls other than tab, LF
 * and CR, lone surrogates, and U+FFFE/U+FFFF. XML forbids them even as character
 * references, so one in a name makes the whole PROPFIND body unparseable.
 */
const NOT_XML_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/gu;

/**
 * Escapes `value` for an XML text node or attribute. Characters XML 1.0 forbids become
 * U+FFFD; the exact name still reaches clients through the percent-encoded `href`.
 */
export function escapeXml(value: string): string {
    return value.replace(NOT_XML_CHAR, '\uFFFD').replace(/[<>&'"]/g, (c) => {
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
