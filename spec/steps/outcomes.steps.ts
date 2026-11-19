// The Thens about what the user saw: listings, reads, refusals, the serve itself and the mount,
// with what the Drive counted while the user looked.
import { type DataTable, Then } from "@cucumber/cucumber";

import { poll } from "@cd-pipeline/support";
import { join } from "node:path";

import { Control, type CallCounts } from "../support/send/control.ts";
import { isMounted, listMounted, type MountOutcome, readMounted } from "../support/send/mount.ts";
import { describe } from "../support/send/rclone.ts";
import { claim, decode, last, refusedWith, type Row, says, showsExactly, sum } from "./claims.ts";
import { DIR_CACHE_TIME_FLAG, type DriveWorld, mountedLines } from "./world.ts";

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

Then(/^the first write fails as a gateway timeout, and the second one succeeds$/, function (this: DriveWorld) {
  const [first, second] = this.actionsOf("write");
  claim(first && second, () => `two writes were not recorded.\n${this.whatHappened()}`);
  refusedWith(this, first, "PUT", 504);
  claim(second.outcome.exitCode === 0, () => `the second write of "${second.path}" failed:\n${describe(second.outcome)}\n${this.whatHappened()}`);
});

Then(/^the write to "([^"]*)" fails as a gateway timeout, and the write to "([^"]*)" succeeds$/, function (this: DriveWorld, failedPath: string, path: string) {
  const writes = this.actionsOf("write");
  const failed = writes.find((write) => write.path === failedPath);
  const succeeded = writes.find((write) => write.path === path);
  claim(failed && succeeded, () => `the writes of "${failedPath}" and "${path}" were not both recorded.\n${this.whatHappened()}`);
  refusedWith(this, failed, "PUT", 504);
  claim(succeeded.outcome.exitCode === 0, () => `the write of "${path}" failed:\n${describe(succeeded.outcome)}\n${this.whatHappened()}`);
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

Then(/^the mount printed one line that says it is mounted at the folder, and the folder was mounted when it did$/, function (this: DriveWorld) {
  const mount = this.mount;
  claim(mount, () => `no mount started.\n${this.whatHappened()}`);
  const lines = mountedLines(mount.process.output, mount.mountpoint);
  claim(lines.length === 1, () => `the mount printed ${lines.length} lines that say it is mounted at ${mount.mountpoint}, not 1.\n${this.whatHappened()}`);
  claim(this.readiness.line?.mounted, () => `the mount said it was mounted at ${mount.mountpoint} before the folder was mounted.\n${this.whatHappened()}`);
});

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

Then(
  /^the mounted file "([^"]*)" held "([^"]*)" at first, and within (\d+) seconds it holds "([^"]*)" on two reads in a row$/,
  async function (this: DriveWorld, path: string, before: string, seconds: string, after: string) {
    const mount = this.mount;
    claim(mount, () => `nothing was mounted.\n${this.whatHappened()}`);
    const first = this.mountedRead?.file;
    claim(first, () => `nothing was read through the mount.\n${this.whatHappened()}`);
    claim(first.exitCode === 0, () => `the first read of the mounted file failed (${first.command}): ${first.stderr}\n${this.whatHappened()}`);
    claim(decode(first.stdout) === before, () => `the first read of the mounted file gave "${decode(first.stdout)}", not "${before}"`);
    const reads: MountOutcome[] = [];
    const gives = (read: MountOutcome | undefined) => read?.exitCode === 0 && decode(read.stdout) === after;
    const read = async () => {
      reads.push(await readMounted(join(mount.mountpoint, path)));
      return reads.at(-1);
    };
    await poll(async () => gives(await read()) && gives(await read()), { withinMs: Number(seconds) * 1000 });
    const said = (read: MountOutcome | undefined) =>
      !read ? "nothing" : read.exitCode === 0 ? `"${decode(read.stdout)}"` : `a failure (${read.command}): ${read.stderr}`;
    claim(reads.length > 0, () => `the mounted file "${path}" was never read again.\n${this.whatHappened()}`);
    claim(
      gives(reads.at(-2)) && gives(reads.at(-1)),
      () => `after ${seconds} s the last two reads of the mounted file "${path}" gave ${said(reads.at(-2))} and ${said(reads.at(-1))}, not "${after}".\n${this.whatHappened()}`,
    );
  },
);

Then(/^the mount's log names "([^"]*)" as not yet on the Drive$/, function (this: DriveWorld, path: string) {
  const mount = this.mount;
  claim(mount, () => `the mount was never started.\n${this.whatHappened()}`);
  claim(mount.process.ending, () => `the mount did not end.\n${this.whatHappened()}`);
  const pending = mount.process.output.split("\n").filter((line) => line.includes(path) && line.includes("not yet on the Drive"));
  claim(pending.length > 0, () => `the mount's log has no line naming "${path}" as not yet on the Drive.\n${this.whatHappened()}`);
});

/** The count each line of `output` gives of the uploads the mount has not finished, in order. */
function pendingCounts(output: string): string[] {
  return output.split("\n").flatMap((line) => line.match(/\b\d+ uploads? pending\b/)?.[0] ?? []);
}

Then(/^within (\d+) seconds the mount's latest count of pending uploads is "([^"]*)"$/, async function (this: DriveWorld, seconds: string, count: string) {
  const mount = this.mount;
  claim(mount, () => `the mount was never started.\n${this.whatHappened()}`);
  await poll(() => pendingCounts(mount.process.output).at(-1) === count, { withinMs: Number(seconds) * 1000 });
  const counts = pendingCounts(mount.process.output);
  claim(
    counts.at(-1) === count,
    () => `after ${seconds} s the mount's latest count of pending uploads is ${counts.length ? `"${counts.at(-1)}"` : "missing: it logged none"}, not "${count}".\n${this.whatHappened()}`,
  );
});

Then(/^the mount exits 0 on its own, and the folder is no longer mounted$/, function (this: DriveWorld) {
  const mount = this.mount;
  claim(mount, () => `the mount was never started.\n${this.whatHappened()}`);
  claim(this.mountedBeforeStop, () => `${mount.mountpoint} was not mounted when the mount was stopped.\n${this.whatHappened()}`);
  const ending = mount.process.ending;
  claim(ending, () => `the mount did not end.\n${this.whatHappened()}`);
  claim(!ending.forced, () => `the mount did not end on its own after it was stopped, so it was killed.\n${this.whatHappened()}`);
  claim(ending.code === 0, () => `the mount exited with ${ending.code ?? ending.signal}, not 0.\n${this.whatHappened()}`);
  claim(!isMounted(mount.mountpoint), () => `${mount.mountpoint} is still mounted after the mount ended.\n${this.whatHappened()}`);
});

Then(/^the mount exits (\d+) saying "(.*)"$/, async function (this: DriveWorld, code: string, text: string) {
  const mount = this.mount?.process;
  claim(mount, () => `the mount was never started.\n${this.whatHappened()}`);
  await mount.waitForEnd(10_000);
  claim(mount.ending, () => `the mount was still running 10 s after the last step.\n${this.whatHappened()}`);
  claim(mount.output.includes(text), () => `the mount did not say "${text}".\n${this.whatHappened()}`);
  claim(mount.ending.code === Number(code), () => `the mount said "${text}" but did not exit ${code}.\n${this.whatHappened()}`);
});
