import { type NodeEntity, NodeType } from '@protontech/drive-sdk';

/** A file or folder as the WebDAV layer sees it. */
export type Entry = {
    uid: string;
    name: string;
    kind: 'file' | 'folder';
    /** Clear-text size in bytes; 0 for folders. */
    size: number;
    modified: Date;
    created: Date;
    mediaType?: string;
    sha1?: string;
    /** Changes with each new revision; used as the ETag. */
    revisionUid?: string;
    /** UID of the folder that holds this node; missing for a root folder. */
    parentUid?: string;
    treeEventScopeId: string;
    /** A file's node key, armored and still locked; `migrate-node-keys` reads its version and lock from it. */
    armoredNodeKey?: string;
};

export type Skipped = { skipped: string };

/**
 * Converts an SDK node. Returns `{ skipped }` for nodes the server must not
 * show: trashed nodes, names the SDK cannot decrypt, albums, and files with no
 * clear-text size (a size of 0 would make rclone copy them as empty files).
 */
export function toEntry(node: NodeEntity): Entry | Skipped {
    if (node.trashTime) {
        return { skipped: 'trashed' };
    }
    if (!node.name.ok) {
        return { skipped: 'name cannot be decrypted' };
    }
    const base = {
        uid: node.uid,
        name: node.name.value,
        created: node.creationTime,
        parentUid: node.parentUid,
        treeEventScopeId: node.treeEventScopeId,
    };
    if (node.type === NodeType.Folder) {
        return { ...base, kind: 'folder', size: 0, modified: node.modificationTime };
    }
    if (node.type !== NodeType.File && node.type !== NodeType.Photo) {
        return { skipped: `type ${node.type} is not served` };
    }
    const revision = node.activeRevision;
    if (revision?.claimedSize === undefined) {
        return { skipped: 'no clear-text size' };
    }
    return {
        ...base,
        kind: 'file',
        size: revision.claimedSize,
        modified: revision.claimedModificationTime ?? node.modificationTime,
        mediaType: node.mediaType === undefined ? undefined : cleanMediaType(node.mediaType),
        sha1: revision.claimedDigests?.sha1,
        revisionUid: revision.uid,
        armoredNodeKey: node.encryptedCrypto?.armoredKey,
    };
}

// RFC 9110 section 8.3.1: type "/" subtype *( OWS ";" OWS [ name "=" ( token / quoted-string ) ] ),
// kept to US-ASCII so the value is always a valid header value.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED_STRING = '"(?:[\\t \\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\t \\x21-\\x7e])*"';
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(?:[ \\t]*;[ \\t]*(?:${TOKEN}=(?:${TOKEN}|${QUOTED_STRING}))?)*$`);

/**
 * The Drive's media type when it is a valid media type, else `application/octet-stream`. The value
 * comes from whoever uploaded the file and goes into the Content-Type header and PROPFIND, so a CR,
 * LF or other control character in it must never reach them.
 */
function cleanMediaType(mediaType: string): string {
    return MEDIA_TYPE.test(mediaType) ? mediaType : 'application/octet-stream';
}

export function isSkipped(value: Entry | Skipped): value is Skipped {
    return 'skipped' in value;
}
