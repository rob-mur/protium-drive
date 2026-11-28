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

/** Children rendered into each chunk of a streamed multistatus body: about 128 KB. */
const ENTRIES_PER_CHUNK = 256;

const encoder = new TextEncoder();

/**
 * Streams a PROPFIND multistatus body: the target first, then its children,
 * ENTRIES_PER_CHUNK of them at a time as the reader asks, so a large folder's
 * XML never sits in memory whole (#183). `onEnd` runs once, when the body is
 * read to its end, fails or is cancelled. `before` runs ahead of the first chunk.
 */
export function multistatusStream(
    segments: string[],
    target: Entry,
    children: readonly Entry[],
    hooks: { before?: () => Promise<void>; onEnd?: () => void } = {},
): ReadableStream<Uint8Array> {
    let next = -1;
    let ended = false;
    const end = () => {
        if (!ended) {
            ended = true;
            hooks.onEnd?.();
        }
    };
    return new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                try {
                    if (next < 0) {
                        await hooks.before?.();
                        next = 0;
                        controller.enqueue(
                            encoder.encode(
                                `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${propResponse(segments, target)}`,
                            ),
                        );
                        return;
                    }
                    if (next >= children.length) {
                        controller.enqueue(encoder.encode('</D:multistatus>\n'));
                        controller.close();
                        end();
                        return;
                    }
                    let chunk = '';
                    const stop = Math.min(next + ENTRIES_PER_CHUNK, children.length);
                    for (; next < stop; next++) {
                        const child = children[next];
                        chunk += `\n${propResponse([...segments, child.name], child)}`;
                    }
                    controller.enqueue(encoder.encode(chunk));
                } catch (error: unknown) {
                    end();
                    throw error;
                }
            },
            cancel: end,
        },
        { highWaterMark: 0 },
    );
}
