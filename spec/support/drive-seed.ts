// The Drive a scenario arranges, written to the Receive arm's directory before the binary starts.
// fake-drive keeps its Drive in `DIR/drive.json` and `DIR/blobs/<sha256>`, and its state format is
// its seed format (fake-drive/drive.ts, `DriveState`), so the suite writes that format directly:
// it needs none of the product's dependencies, and a folder of 5000 photos is one write rather
// than 5000.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCOPE_ID = "volume-1";

export interface SeedFile {
  content: Uint8Array;
  mediaType?: string;
  /** The SDK gives the name as one it cannot decrypt. */
  nameUndecryptable?: boolean;
  /** False: the SDK gives no clear-text size. */
  clearTextSize?: boolean;
  /** In the trash, not in My files. */
  trashed?: boolean;
  /** The node key the file holds; v4 when not given (fake-drive/node-keys.ts). */
  nodeKey?: "v4" | "argon2";
  /** The modification time the file's client claimed, ISO 8601. */
  claimedModificationTime?: string;
}

interface NodeRecord {
  uid: string;
  parentUid?: string;
  name: string;
  type: "file" | "folder";
  created: string;
  modified: string;
  trashed?: string;
  revisions: RevisionRecord[];
  nameUndecryptable?: boolean;
  clearTextSize?: boolean;
  nodeKey?: "v4" | "argon2";
  claimedModificationTime?: string;
}

interface RevisionRecord {
  uid: string;
  created: string;
  claimedModificationTime?: string;
  blob: string;
  size: number;
  declaredSize: number | null;
  mediaType: string;
}

/** A Drive's My files and trash, by `/`-separated path from My files. */
export class DriveSeed {
  private readonly folders = new Set<string>();
  private readonly files = new Map<string, SeedFile>();
  /** The Drive unlocks node keys and decrypts downloads for real, through the product's crypto pool (fake-drive/real-crypto.ts). */
  realCrypto = false;

  folder(path: string): void {
    this.folders.add(path);
  }

  file(path: string, file: SeedFile): void {
    this.files.set(path, file);
  }

  /** The file arranged at `path`, if one was. */
  fileAt(path: string): SeedFile | undefined {
    return this.files.get(path);
  }

  /** The paths arranged directly in the folder `folder`. */
  childrenOf(folder: string): string[] {
    const paths = [...this.folders, ...this.files.keys(), ...[...this.files.keys(), ...this.folders].flatMap(ancestors)];
    return [...new Set(paths)].filter((path) => parentOf(path) === folder);
  }

  /** Writes the Drive to `dir`. Returns the UID of each node, by path. */
  write(dir: string): Map<string, string> {
    const now = new Date().toISOString();
    const rootUid = `${SCOPE_ID}~link-1`;
    let nextId = 2;
    const nodes: Record<string, NodeRecord> = {
      [rootUid]: { uid: rootUid, name: "root", type: "folder", created: now, modified: now, revisions: [] },
    };
    const uids = new Map<string, string>([["", rootUid]]);
    const blobs = new Map<string, Uint8Array>();

    const folder = (path: string): string => {
      const known = uids.get(path);
      if (known) return known;
      const parentUid = folder(parentOf(path));
      const uid = `${SCOPE_ID}~link-${nextId++}`;
      nodes[uid] = { uid, parentUid, name: nameOf(path), type: "folder", created: now, modified: now, revisions: [] };
      uids.set(path, uid);
      return uid;
    };

    for (const path of [...this.folders].sort()) folder(path);
    for (const [path, file] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const parentUid = folder(parentOf(path));
      const uid = `${SCOPE_ID}~link-${nextId++}`;
      const blob = createHash("sha256").update(file.content).digest("hex");
      blobs.set(blob, file.content);
      const node: NodeRecord = {
        uid,
        parentUid,
        name: nameOf(path),
        type: "file",
        created: now,
        modified: now,
        revisions: [
          {
            uid: `${uid}~rev-${nextId++}`,
            created: now,
            blob,
            size: file.content.length,
            declaredSize: file.content.length,
            mediaType: file.mediaType ?? "application/octet-stream",
          },
        ],
      };
      if (file.trashed) node.trashed = now;
      if (file.nameUndecryptable !== undefined) node.nameUndecryptable = file.nameUndecryptable;
      if (file.clearTextSize !== undefined) node.clearTextSize = file.clearTextSize;
      if (file.nodeKey !== undefined) node.nodeKey = file.nodeKey;
      if (file.claimedModificationTime !== undefined) {
        node.claimedModificationTime = file.claimedModificationTime;
        node.revisions[0]!.claimedModificationTime = file.claimedModificationTime;
      }
      nodes[uid] = node;
      uids.set(path, uid);
    }

    mkdirSync(join(dir, "blobs"), { recursive: true });
    for (const [blob, content] of blobs) writeFileSync(join(dir, "blobs", blob), content);
    writeFileSync(join(dir, "drive.json"), `${JSON.stringify({ format: 1, rootUid, nextId, nextEventId: 1, nodes, events: [], ...(this.realCrypto ? { realCrypto: true } : {}) }, null, 2)}\n`);
    return uids;
  }
}

export function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function ancestors(path: string): string[] {
  const found: string[] = [];
  for (let at = parentOf(path); at !== ""; at = parentOf(at)) found.push(at);
  return found;
}
