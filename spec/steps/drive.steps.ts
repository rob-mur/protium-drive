// The Givens: the Drive, its faults and the account, arranged on the World. None starts a
// process or calls a control channel; the first When writes and sets what they arranged.
import { Given } from "@cucumber/cucumber";

import type { Fault } from "../support/send/control.ts";
import type { DriveWorld } from "./world.ts";

const text = (content: string) => new TextEncoder().encode(content);

Given(/^(?:a Drive whose|the Drive's) My files holds the file "([^"]*)" containing "([^"]*)"$/, function (this: DriveWorld, path: string, content: string) {
  this.seed.file(path, { content: text(content) });
});

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

Given(/^the Drive refuses the next upload into "([^"]*)" because the name exists$/, function (this: DriveWorld, folder: string) {
  fault(this, "name-clash", "getFileUploader", folder);
});

// --- the account and the serve's options ------------------------------------------------

Given(/^the user has signed in$/, function (this: DriveWorld) {
  this.signedIn = true;
});

Given(/^the user mounts the Drive at a folder$/, function (this: DriveWorld) {
  this.mounted = true;
});
