// The Givens: the Drive, its faults and the account, arranged on the World. None starts a
// process or calls a control channel; the first When writes and sets what they arranged.
import { Given } from "@cucumber/cucumber";

import type { Fault } from "../support/send/control.ts";
import type { DriveWorld } from "./world.ts";

const text = (content: string) => new TextEncoder().encode(content);

Given(/^(?:a Drive whose|the Drive's) My files holds the file "([^"]*)" containing "([^"]*)"$/, function (this: DriveWorld, path: string, content: string) {
  this.seed.file(path, { content: text(content) });
});

// The names no path can hold: each is one name in the Drive, but a path would read it as
// another segment, as no segment, or as cut off, and Linux holds no name over 255 bytes.
export const UNREACHABLE_NAMES: Record<string, string> = {
  ".": ".",
  "..": "..",
  "a slash": "a/b",
  "a NUL": "a\0b",
  "300 bytes": "x".repeat(300),
};

Given(
  /^the Drive's "([^"]*)" also holds a file named each of "\.", "\.\.", one with a slash, one with a NUL, and one of 300 bytes$/,
  function (this: DriveWorld, folder: string) {
    for (const [label, name] of Object.entries(UNREACHABLE_NAMES)) {
      this.seed.file(`${folder}/unreachable name ${label}`, { content: text("hidden"), name });
    }
  },
);

// The modification time the arranged files' client claimed: the migration is to keep it.
export const CLAIMED_MODIFICATION_TIME = "2026-08-14T09:30:00.000Z";

Given(
  /^(?:a Drive whose|the Drive's) My files holds the file "([^"]*)" containing "([^"]*)" with an Argon2-locked node key$/,
  function (this: DriveWorld, path: string, content: string) {
    this.seed.file(path, { content: text(content), nodeKey: "argon2", claimedModificationTime: CLAIMED_MODIFICATION_TIME });
  },
);

Given(
  /^(?:a Drive whose|the Drive's) My files holds the file "([^"]*)" containing "([^"]*)" with a v4 node key$/,
  function (this: DriveWorld, path: string, content: string) {
    this.seed.file(path, { content: text(content), nodeKey: "v4", claimedModificationTime: CLAIMED_MODIFICATION_TIME });
  },
);

Given(/^(?:a Drive whose|the Drive's) My files holds the folder "([^"]*)"$/, function (this: DriveWorld, path: string) {
  this.seed.folder(path);
});

// --- faults: each one meets the next matching call of the serve -------------------------

const LISTING = "iterateFolderChildrenNodeUids";

function fault(world: DriveWorld, kind: Fault["kind"], operation: string, path: string, times = 1): void {
  for (let i = 0; i < times; i++) world.faults.push({ kind, operation, path });
}

Given(/^the Drive answers the next listing of "([^"]*)" with a server error$/, function (this: DriveWorld, path: string) {
  fault(this, "server-error", LISTING, path);
});

Given(/^the Drive cannot be reached for the next listing of "([^"]*)"$/, function (this: DriveWorld, path: string) {
  fault(this, "unreachable", LISTING, path);
});

Given(/^the Drive rate-limits the next listing of "([^"]*)"$/, function (this: DriveWorld, path: string) {
  fault(this, "rate-limited", LISTING, path);
});

Given(/^the file "([^"]*)" fails its integrity check$/, function (this: DriveWorld, path: string) {
  fault(this, "integrity", "getFileDownloader", path);
});

Given(/^the next upload into "([^"]*)" stops moving bytes$/, function (this: DriveWorld, folder: string) {
  fault(this, "upload-stall", "getFileUploader", folder);
});

Given(/^the next upload into "([^"]*)" moves a tenth of its bytes each minute$/, function (this: DriveWorld, folder: string) {
  fault(this, "upload-slow", "getFileUploader", folder);
});

Given(/^the next upload into "([^"]*)" waits until another upload ends$/, function (this: DriveWorld, path: string) {
  fault(this, "upload-queued", "getFileUploader", path);
});

Given(/^the next upload into "([^"]*)" waits for its turn to start$/, function (this: DriveWorld, folder: string) {
  fault(this, "upload-wait", "getFileUploader", folder);
});

Given(/^the Drive refuses the next upload into "([^"]*)" because the name exists$/, function (this: DriveWorld, folder: string) {
  fault(this, "name-clash", "getFileUploader", folder);
});

// --- what Proton's requirement headers say on each Drive call of the serve ---------------

Given(/^Proton requires SDK (\d+\.\d+\.\d+) or newer$/, function (this: DriveWorld, version: string) {
  this.requirements.required = version;
});

Given(/^Proton suggests SDK (\d+\.\d+\.\d+) or newer$/, function (this: DriveWorld, version: string) {
  this.requirements.suggested = version;
});

Given(/^Proton requires the (drive|photos|docs) feature mask (\d+)$/, function (this: DriveWorld, scope: "drive" | "photos" | "docs", mask: string) {
  this.requirements[scope] = Number(mask);
});

// --- the account and the serve's options ------------------------------------------------

Given(/^the user has signed in$/, function (this: DriveWorld) {
  this.signedIn = true;
});

Given(/^the user has not signed in$/, function (this: DriveWorld) {
  this.signedIn = false;
});

Given(/^the Proton account refuses the next refresh$/, function (this: DriveWorld) {
  this.refusesNextRefresh = true;
});

Given(/^Proton has refused the stored session$/, function (this: DriveWorld) {
  this.sessionRefused = true;
});

Given(/^the user keeps the serve's credential in a file only they can read$/, function (this: DriveWorld) {
  this.credentialFile = { mode: 0o600 };
});

Given(/^the user keeps the serve's credential in a file that other users can read$/, function (this: DriveWorld) {
  this.credentialFile = { mode: 0o644 };
});

Given(/^the user serves the Drive with no credential$/, function (this: DriveWorld) {
  this.noCredential = true;
});

Given(/^the user cannot write to the serve's state folder$/, function (this: DriveWorld) {
  this.stateReadOnly = true;
});

Given(/^the user mounts the Drive at a folder$/, function (this: DriveWorld) {
  this.mounted = true;
});

Given(/^the folder the user mounts the Drive at does not exist$/, function (this: DriveWorld) {
  this.mountFolder = { kind: "missing" };
});

Given(/^the folder the user mounts the Drive at holds the file "([^"]*)"$/, function (this: DriveWorld, file: string) {
  this.mountFolder = { kind: "holds", file };
});

Given(/^the folder the user mounts the Drive at was left mounted by a mount that was killed$/, function (this: DriveWorld) {
  this.mountFolder = { kind: "left mounted" };
});

Given(/^the user mounts the Drive at a folder with a dir cache time of "([^"]*)"$/, function (this: DriveWorld, time: string) {
  this.mounted = true;
  this.dirCacheTime = time;
});
