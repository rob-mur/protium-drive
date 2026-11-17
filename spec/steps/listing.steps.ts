// The steps about a large folder: a Drive of numbered photos, a serve that restarts or is killed, and the
// Thens that count what the Drive loaded across every listing and read the user made.
// "Loaded N nodes" counts the arranged photos' nodes only, summed over the user's actions, so it
// holds across a restart, which starts the Receive arm's counts again from zero.
import { Given, Then, When } from "@cucumber/cucumber";

import type { CallCounts } from "../support/send/control.ts";
import { claim, last, output, rowsOf } from "./claims.ts";
import type { Action, DriveWorld } from "./world.ts";

/** The arranged photos, by path, in the order of their numbers. */
const photos = new WeakMap<DriveWorld, string[]>();

/** What the photo at `path` contains: its own name, so every photo differs. */
function contentOf(path: string): string {
  return `the photo ${path}`;
}

/** The paths from `first` to `last`: the same text around a zero-padded number. */
function numbered(count: number, first: string, lastPath: string): string[] {
  const shape = /^(.*?)(\d+)(\D*)$/;
  const from = shape.exec(first);
  const to = shape.exec(lastPath);
  if (!from || !to || from[1] !== to[1] || from[3] !== to[3]) throw new Error(`"${first}" and "${lastPath}" are not one numbered series`);
  const width = from[2]!.length;
  const start = Number(from[2]);
  if (Number(to[2]) - start + 1 !== count) throw new Error(`"${first}" to "${lastPath}" is not ${count} paths`);
  return Array.from({ length: count }, (_, i) => `${from[1]}${String(start + i).padStart(width, "0")}${from[3]}`);
}

function photosOf(world: DriveWorld): string[] {
  const paths = photos.get(world);
  claim(paths, () => "no Given arranged a series of photos.");
  return paths;
}

/** How many times the Drive did `per` for `uid` during `action`, from the counts around it. */
function during(world: DriveWorld, action: Action, per: Exclude<keyof CallCounts, "methods">, uid: string): number {
  claim(action.callsBefore && action.callsAfter, () => `the Drive's calls around the ${action.kind} of "${action.path}" could not be read.\n${world.whatHappened()}`);
  return (action.callsAfter[per][uid] ?? 0) - (action.callsBefore[per][uid] ?? 0);
}

/** How many times the Drive did `per` for `uid` during all the user's actions. */
function inAll(world: DriveWorld, per: Exclude<keyof CallCounts, "methods">, uid: string): number {
  return world.actions.reduce((total, action) => total + during(world, action, per, uid), 0);
}

function uidOf(world: DriveWorld, path: string): string {
  const uid = world.uids.get(path);
  claim(uid, () => `the scenario arranged no "${path}".\n${world.whatHappened()}`);
  return uid;
}

/** Claims that the last listing showed `count` files and nothing else. */
function showsFiles(world: DriveWorld, count: number): string[] {
  const rows = rowsOf(world, last(world, "list"));
  const files = rows.filter((row) => row.kind === "file");
  claim(files.length === count && rows.length === count, () => `the last listing showed ${files.length} files and ${rows.length - files.length} other entries, not ${count} files`);
  return files.map((row) => row.name);
}

/** Claims that the Drive loaded the photos' nodes `times` times in all. */
function loadedPhotos(world: DriveWorld, times: number): void {
  const loads = photosOf(world).reduce((total, path) => total + inAll(world, "nodeLoads", uidOf(world, path)), 0);
  claim(loads === times, () => `the Drive loaded the photos' nodes ${loads} times in all, not ${times}.\n${world.whatHappened()}`);
}

/** Claims that the Drive listed the folder `path` once in all. */
function listedOnce(world: DriveWorld, path: string): void {
  const listings = inAll(world, "listings", uidOf(world, path));
  claim(listings === 1, () => `the Drive listed "${path}" ${listings} times, not once.\n${world.whatHappened()}`);
}

// --- the Given -----------------------------------------------------------------------------

Given(
  /^a Drive whose My files holds (\d+) photos "([^"]*)" to "([^"]*)"$/,
  function (this: DriveWorld, count: string, first: string, lastPath: string) {
    const paths = numbered(Number(count), first, lastPath);
    for (const path of paths) this.seed.file(path, { content: new TextEncoder().encode(contentOf(path)), mediaType: "image/jpeg" });
    photos.set(this, paths);
  },
);

// --- the When ------------------------------------------------------------------------------

When(/^the serve restarts$/, async function (this: DriveWorld) {
  await this.restartServe();
});

When(/^a minute passes$/, async function (this: DriveWorld) {
  await this.pass(60);
});

// SIGKILL, as a crash, an out-of-memory kill or a power loss ends it: the serve saves nothing at the end.
When(/^the serve is killed and starts again$/, async function (this: DriveWorld) {
  await this.killServe();
  await this.ensureServing();
});

// --- the Thens -----------------------------------------------------------------------------

Then(
  /^the listing shows (\d+) files from "([^"]*)" to "([^"]*)", and the Drive loaded each of their nodes once$/,
  function (this: DriveWorld, count: string, first: string, lastName: string) {
    const names = showsFiles(this, Number(count)).sort();
    const want = numbered(Number(count), first, lastName);
    claim(JSON.stringify(names) === JSON.stringify(want), () => `the listing showed other names than "${first}" to "${lastName}": ${names.slice(0, 5).join(", ")}...`);
    const list = last(this, "list");
    const loadedOtherThanOnce = photosOf(this).filter((path) => during(this, list, "nodeLoads", uidOf(this, path)) !== 1);
    claim(
      loadedOtherThanOnce.length === 0,
      () => `the Drive did not load ${loadedOtherThanOnce.length} photos' nodes exactly once, e.g. "${loadedOtherThanOnce[0]}" ${during(this, list, "nodeLoads", uidOf(this, loadedOtherThanOnce[0]!))} times`,
    );
  },
);

Then(
  /^the last listing shows (\d+) files, and the Drive listed "([^"]*)" once and loaded (\d+) nodes in all$/,
  function (this: DriveWorld, count: string, folder: string, loads: string) {
    showsFiles(this, Number(count));
    listedOnce(this, folder);
    loadedPhotos(this, Number(loads));
  },
);

Then(/^the read gives the photo's content, and the Drive listed "([^"]*)" once$/, function (this: DriveWorld, folder: string) {
  const read = last(this, "read");
  claim(read.outcome.exitCode === 0, () => `the read of "${read.path}" failed.\n${this.whatHappened()}`);
  const got = output(read.outcome);
  claim(got === contentOf(read.path), () => `the read of "${read.path}" gave "${got}", not "${contentOf(read.path)}"`);
  listedOnce(this, folder);
});

Then(/^the last listing shows (\d+) files, and the Drive loaded (\d+) nodes in all$/, function (this: DriveWorld, count: string, loads: string) {
  showsFiles(this, Number(count));
  loadedPhotos(this, Number(loads));
});
