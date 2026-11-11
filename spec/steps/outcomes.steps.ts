// The Thens about what the user saw: listings, reads, refusals, the serve itself and the mount,
// with what the Drive counted while the user looked.
import { type DataTable, Then } from "@cucumber/cucumber";

import { poll } from "@cd-pipeline/support";
import { join } from "node:path";

import { Control, type CallCounts } from "../support/send/control.ts";
import { listMounted, type MountOutcome } from "../support/send/mount.ts";
import { claim, decode, last, refusedWith, type Row, says, showsExactly, sum } from "./claims.ts";
import { DIR_CACHE_TIME_FLAG, type DriveWorld } from "./world.ts";

function method(calls: CallCounts | undefined, name: string): number {
  return calls?.methods[name] ?? 0;
}

// --- listings -----------------------------------------------------------------------------------

Then(/^the listing shows exactly:$/, function (this: DriveWorld, table: DataTable) {
  showsExactly(this, last(this, "list"), table.hashes() as unknown as Row[]);
});

// --- the Drive's failures -----------------------------------------------------------------------

Then(/^the listing fails as a bad gateway$/, function (this: DriveWorld) {
  refusedWith(this, last(this, "list"), "PROPFIND", 502);
});

Then(/^the read fails as a bad gateway saying the data failed verification$/, function (this: DriveWorld) {
  const read = last(this, "read");
  refusedWith(this, read, "GET", 502);
  says(read, "failed verification");
});

Then(/^the listing fails as unavailable, to retry after (\d+) seconds$/, function (this: DriveWorld, seconds: string) {
  refusedWith(this, last(this, "list"), "PROPFIND", 503, Number(seconds));
});

Then(/^the write fails as a conflict$/, function (this: DriveWorld) {
  refusedWith(this, last(this, "write"), "PUT", 409);
});

// --- the Drive's events -------------------------------------------------------------------------

Then(/^the serve read the Drive's events (\d+) times, and the Drive listed no folder$/, function (this: DriveWorld, times: string) {
  const reads = this.eventReads;
  claim(reads.length === Number(times), () => `the scheduler was polled ${reads.length} times, not ${times}.\n${this.whatHappened()}`);
  const unasked = reads.findIndex((read) => !read.scopes?.length);
  claim(unasked < 0, () => `poll ${unasked + 1} found no event scheduler the serve asked for.\n${this.whatHappened()}`);
  const calls = reads.at(-1)!.callsAfter;
  claim(calls, () => `the Drive's calls could not be read.\n${this.whatHappened()}`);
  claim(method(calls, "iterateEvents") >= Number(times), () => `the serve read the Drive's events ${method(calls, "iterateEvents")} times, not ${times}`);
  claim(sum(calls.listings) === 0, () => `the Drive listed ${sum(calls.listings)} folder(s): ${JSON.stringify(calls.listings)}`);
});

Then(/^the listing was refused as rate-limited, and the serve read no events when the scheduler called it$/, function (this: DriveWorld) {
  refusedWith(this, last(this, "list"), "PROPFIND", 503);
  const read = this.eventReads.at(-1);
  claim(read?.scopes?.length, () => `the scheduler found no event scheduler the serve asked for to call.\n${this.whatHappened()}`);
  claim(read.callsBefore && read.callsAfter, () => `the Drive's calls could not be read.\n${this.whatHappened()}`);
  const readEvents = method(read.callsAfter, "iterateEvents") - method(read.callsBefore, "iterateEvents");
  claim(readEvents === 0, () => `the serve read the Drive's events ${readEvents} time(s) during the pause`);
});

// --- the mount ----------------------------------------------------------------------------------

Then(
  /^the mounted file holds "([^"]*)", and the mounted folder "([^"]*)" holds exactly "([^"]*)"$/,
  function (this: DriveWorld, text: string, folder: string, names: string) {
    const read = this.mountedRead;
    claim(read, () => `nothing was read through the mount.\n${this.whatHappened()}`);
    claim(read.file.exitCode === 0, () => `reading the mounted file failed (${read.file.command}): ${read.file.stderr}\n${this.whatHappened()}`);
    claim(decode(read.file.stdout) === text, () => `the mounted file holds "${decode(read.file.stdout)}", not "${text}"`);
    claim(read.folder.exitCode === 0, () => `listing the mounted folder "${folder}" failed (${read.folder.command}): ${read.folder.stderr}`);
    const listed = decode(read.folder.stdout).split("\n").filter(Boolean).sort();
    const want = names.split(", ").sort();
    claim(JSON.stringify(listed) === JSON.stringify(want), () => `the mounted folder "${folder}" holds ${JSON.stringify(listed)}, not ${JSON.stringify(want)}`);
  },
);

Then(
  /^the mount is refused with exit status (\d+) and a message that names the folder, and the folder still holds exactly "([^"]*)"$/,
  function (this: DriveWorld, status: string, names: string) {
    const run = this.mountRun;
    claim(run, () => `no mount ran to its end.\n${this.whatHappened()}`);
    const want = names.split(", ").sort();
    claim(
      JSON.stringify(run.folderAfter?.sort()) === JSON.stringify(want),
      () => `the folder holds ${JSON.stringify(run.folderAfter)}, not ${JSON.stringify(want)}.\n${this.whatHappened()}`,
    );
    claim(run.answer.exitCode === Number(status), () => `the mount exited ${run.answer.exitCode}, not ${status}.\n${this.whatHappened()}`);
    const message = `${run.answer.stdout}${run.answer.stderr}`;
    claim(message.includes(this.dirs.mountpoint), () => `the mount's message does not name ${this.dirs.mountpoint}: ${message}`);
  },
);

Then(
  /^within (\d+) seconds the mounted folder "([^"]*)" holds exactly "([^"]*)"$/,
  async function (this: DriveWorld, seconds: string, folder: string, names: string) {
    const mount = this.mount;
    claim(mount, () => `nothing was mounted.\n${this.whatHappened()}`);
    const want = JSON.stringify(names.split(", ").sort());
    let last: MountOutcome | undefined;
    const listed = () => (last ? JSON.stringify(decode(last.stdout).split("\n").filter(Boolean).sort()) : "nothing");
    await poll(async () => {
      last = await listMounted(join(mount.mountpoint, folder));
      return last.exitCode === 0 && listed() === want;
    }, { withinMs: Number(seconds) * 1000 });
    claim(last, () => `the mounted folder "${folder}" was never listed.\n${this.whatHappened()}`);
    claim(last.exitCode === 0, () => `listing the mounted folder "${folder}" failed (${last!.command}): ${last!.stderr}\n${this.whatHappened()}`);
    claim(listed() === want, () => `after ${seconds} s the mounted folder "${folder}" holds ${listed()}, not ${want}.\n${this.whatHappened()}`);
  },
);

Then(/^the mount exited with status 2, naming the dir cache time, and served nothing$/, function (this: DriveWorld) {
  const mount = this.mount;
  claim(mount, () => `the mount was never started.\n${this.whatHappened()}`);
  const ending = mount.process.ending;
  claim(ending, () => `the mount did not end on its own.\n${this.whatHappened()}`);
  claim(ending.code === 2, () => `the mount exited with ${ending.code ?? ending.signal}, not 2.\n${this.whatHappened()}`);
  claim(mount.process.stderr.includes(DIR_CACHE_TIME_FLAG), () => `the mount's message does not name ${DIR_CACHE_TIME_FLAG}.\n${this.whatHappened()}`);
  claim(Control.fromOutput(mount.process.output) === undefined, () => `the mount started the serve before it refused.\n${this.whatHappened()}`);
});
