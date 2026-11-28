// A read of a file while an indexer walks the mount: folders of Argon2-locked files, a Drive that
// does the SDK's crypto for real, the walk with a read inside it, and the Then that times the read.
//
// What it guards: on build ab7112f one crypto worker took every Argon2 unlock, every node-key import
// and every block decryption in turn, so a walk that queued unlocks held every read behind them
// (first byte in 9-80 s on the live mount). Since #118 the unlocks have a worker of their own.
//
// A read of a file whose node key was never unlocked must unlock that key too, and each Argon2
// unlock costs many times its 0.4 s on a busy machine. So that read is not timed in seconds (#194):
// it is timed against the walk itself, which can go on to the next folder only once the serve has
// unlocked every file of the folder it is in.
import { poll } from "@cd-pipeline/support";
import { Given, Then, When } from "@cucumber/cucumber";
import { dirname, join } from "node:path";

import { type MountOutcome, readStartOfMounted, startWalk } from "../support/send/mount.ts";
import { claim, decode } from "./claims.ts";
import type { DriveWorld } from "./world.ts";

/** How long the walk gets to ask the Drive for the nodes that start the read. */
const WALK_START_MS = 60_000;

interface WalkedRead {
  /** How many of the walked files' nodes the Drive had been asked for when the read started. */
  loadsAtRead?: number;
  /** The walked folders the Drive had been asked for nodes of when the read started. */
  foldersAtRead?: string[];
  /** The walked folders the Drive had been asked for nodes of when the read ended. */
  foldersAfterRead?: string[];
  read?: MountOutcome;
  /** Whether the walk was still running when the read ended. */
  walkRunningAfterRead?: boolean;
  walk?: MountOutcome;
}

/** The files the walk meets, by path. */
const walkedFiles = new WeakMap<DriveWorld, string[]>();
/** What each file arranged for a read holds, by path. */
const contents = new WeakMap<DriveWorld, Map<string, Uint8Array>>();
const walkedReads = new WeakMap<DriveWorld, WalkedRead>();

/** `size` bytes that differ from one file to the next and along the file. */
function contentOf(path: string, size: number): Uint8Array {
  const content = new Uint8Array(size);
  let state = [...path].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);
  for (let i = 0; i < size; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    content[i] = state >>> 24;
  }
  return content;
}

/** The paths from `first` to `last`: the same text around a number that counts up. */
function numbered(first: string, last: string): string[] {
  const [, prefix, from] = /^(.*?)(\d+)$/.exec(first) ?? [];
  const [, lastPrefix, to] = /^(.*?)(\d+)$/.exec(last) ?? [];
  if (prefix === undefined || from === undefined || to === undefined || prefix !== lastPrefix) {
    throw new Error(`"${first}" to "${last}" is not a run of numbered paths`);
  }
  const paths: string[] = [];
  for (let n = Number(from); n <= Number(to); n++) paths.push(`${prefix}${String(n).padStart(from.length, "0")}`);
  return paths;
}

// --- the Givens ----------------------------------------------------------------------------

Given(
  /^a Drive whose My files holds the folders "([^"]*)" to "([^"]*)" of (\d+) files each, every file with an Argon2-locked node key$/,
  function (this: DriveWorld, first: string, last: string, count: string) {
    const files: string[] = [];
    for (const folder of numbered(first, last)) {
      for (let n = 1; n <= Number(count); n++) files.push(`${folder}/IMG_${String(n).padStart(4, "0")}.jpg`);
    }
    for (const path of files) this.seed.file(path, { content: contentOf(path, 1024), mediaType: "image/jpeg", nodeKey: "argon2" });
    walkedFiles.set(this, files);
  },
);

Given(
  /^the Drive's My files holds the (\d+) MiB file "([^"]*)" with an Argon2-locked node key$/,
  function (this: DriveWorld, mebibytes: string, path: string) {
    const content = contentOf(path, Number(mebibytes) * 1024 * 1024);
    this.seed.file(path, { content, mediaType: "image/jpeg", nodeKey: "argon2" });
    const known = contents.get(this) ?? new Map<string, Uint8Array>();
    known.set(path, content);
    contents.set(this, known);
  },
);

Given(/^the Drive unlocks node keys and decrypts downloads for real$/, function (this: DriveWorld) {
  this.seed.realCrypto = true;
});

// --- the When ------------------------------------------------------------------------------

When(
  /^an indexer walks the mounted folder "([^"]*)", and once the Drive has been asked for (\d+) of the walked nodes the user reads the first (\d+) KiB of the mounted file "([^"]*)"$/,
  async function (this: DriveWorld, folder: string, loads: string, kibibytes: string, path: string) {
    const record: WalkedRead = {};
    walkedReads.set(this, record);
    const mount = await this.ensureMounted();
    const walkedUids = (walkedFiles.get(this) ?? []).map((walked) => this.uids.get(walked)).filter((uid) => uid !== undefined);
    const walk = startWalk(join(mount.mountpoint, folder));
    try {
      // The walk's node loads, each an Argon2 unlock, are queued once the Drive has been asked for them.
      const asked = async (): Promise<number> => {
        const { nodeLoads } = (await mount.control?.calls()) ?? { nodeLoads: {} as Record<string, number> };
        return walkedUids.reduce((total, uid) => total + (nodeLoads[uid] ?? 0), 0);
      };
      // The walked folders that hold a file the Drive has been asked for the node of.
      const reached = async (): Promise<string[]> => {
        const { nodeLoads } = (await mount.control?.calls()) ?? { nodeLoads: {} as Record<string, number> };
        const folders = (walkedFiles.get(this) ?? []).filter((walked) => (nodeLoads[this.uids.get(walked) ?? ""] ?? 0) > 0).map(dirname);
        return [...new Set(folders)].sort();
      };
      let seen = 0;
      await poll(async () => (seen = await asked()) >= Number(loads) || !walk.running(), { withinMs: WALK_START_MS }).catch(() => {});
      record.loadsAtRead = seen;
      record.foldersAtRead = await reached();
      if (!walk.running()) this.trouble(`the walk ended before the Drive was asked for ${loads} of its nodes`);
      else if (seen < Number(loads)) this.trouble(`the walk asked the Drive for ${seen} of its nodes within ${WALK_START_MS / 1000} s, not ${loads}`);
      record.read = await readStartOfMounted(join(mount.mountpoint, path), Number(kibibytes) * 1024);
      record.walkRunningAfterRead = walk.running();
      record.foldersAfterRead = await reached();
    } finally {
      walk.stop();
      record.walk = await walk.ended;
    }
  },
);

// --- the Then ------------------------------------------------------------------------------

Then(
  /^the read gives the file's first (\d+) KiB, its first byte comes within (\d+) seconds, and the walk was still running when it ended$/,
  function (this: DriveWorld, kibibytes: string, seconds: string) {
    const record = walkedReads.get(this);
    claim(record?.read, () => `no read was made during a walk.\n${this.whatHappened()}`);
    const { read } = record;
    const timings = `first byte at ${read.firstByteMs?.toFixed(0) ?? "never"} ms, read ended at ${read.ms.toFixed(0)} ms, ${record.loadsAtRead} walked nodes asked for at its start, walk ${record.walkRunningAfterRead ? "still running" : "ended"} when it ended`;
    console.log(`walk-read: ${timings}`);
    const [path, content] = [...(contents.get(this) ?? new Map<string, Uint8Array>())][0] ?? [];
    claim(path && content, () => `no file was arranged for the read.\n${this.whatHappened()}`);
    claim(read.exitCode === 0, () => `the read of "${path}" exited ${read.exitCode} (${read.command}): ${read.stderr} (${timings})\n${this.whatHappened()}`);
    const want = content.subarray(0, Number(kibibytes) * 1024);
    claim(
      Buffer.from(read.stdout).equals(Buffer.from(want)),
      () => `the read gave ${read.stdout.length} bytes that are not the first ${kibibytes} KiB of "${path}": ${decode(read.stdout.subarray(0, 64))}…\n${this.whatHappened()}`,
    );
    claim(
      read.firstByteMs !== undefined && read.firstByteMs < Number(seconds) * 1000,
      () => `the read's first byte did not come within ${seconds} s: ${timings}.\n${this.whatHappened()}`,
    );
    claim(record.walkRunningAfterRead, () => `the walk had ended before the read did, so the read did not wait on it: ${timings}.\n${this.whatHappened()}`);
  },
);

Then(
  /^the read gives the file's first (\d+) KiB before the walk goes on to a folder it had not reached when the read started$/,
  function (this: DriveWorld, kibibytes: string) {
    const record = walkedReads.get(this);
    claim(record?.read, () => `no read was made during a walk.\n${this.whatHappened()}`);
    const { read } = record;
    const atRead = record.foldersAtRead ?? [];
    const afterRead = record.foldersAfterRead ?? [];
    const timings = `first byte at ${read.firstByteMs?.toFixed(0) ?? "never"} ms, read ended at ${read.ms.toFixed(0)} ms, ${record.loadsAtRead} walked nodes asked for at its start, the walk in ${atRead.join(", ") || "no folder"} at its start and in ${afterRead.join(", ") || "no folder"} at its end`;
    console.log(`walk-read: ${timings}`);
    const [path, content] = [...(contents.get(this) ?? new Map<string, Uint8Array>())][0] ?? [];
    claim(path && content, () => `no file was arranged for the read.\n${this.whatHappened()}`);
    claim(read.exitCode === 0, () => `the read of "${path}" exited ${read.exitCode} (${read.command}): ${read.stderr} (${timings})\n${this.whatHappened()}`);
    const want = content.subarray(0, Number(kibibytes) * 1024);
    claim(
      Buffer.from(read.stdout).equals(Buffer.from(want)),
      () => `the read gave ${read.stdout.length} bytes that are not the first ${kibibytes} KiB of "${path}": ${decode(read.stdout.subarray(0, 64))}…\n${this.whatHappened()}`,
    );
    claim(atRead.length > 0, () => `the walk had reached no folder of Argon2-locked files when the read started: ${timings}.\n${this.whatHappened()}`);
    // Each folder the walk reaches holds files whose node keys are still to unlock. So the walk
    // goes on to a new folder only once those unlocks are done: a read that waited behind them
    // ends after the walk has gone on.
    const newFolders = afterRead.filter((folder) => !atRead.includes(folder));
    claim(
      newFolders.length === 0,
      () => `the walk went on to ${newFolders.join(", ")} before the read ended, so the read waited behind the walk's unlocks: ${timings}.\n${this.whatHappened()}`,
    );
  },
);
