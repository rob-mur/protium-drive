// The Thens about signing in, the sign-in status, signing out and the session's refreshes.
import { existsSync, statSync } from "node:fs";

import { Then } from "@cucumber/cucumber";

import { indent } from "../support/send/binary.ts";
import { claim } from "./claims.ts";
import type { DriveWorld } from "./world.ts";

/** What the last command answered, stdout then stderr. */
function answered(world: DriveWorld): string {
  const answer = world.lastAnswer();
  return `${answer.stdout}${answer.stderr}`;
}

Then(
  /^the binary says Proton keeps the session until it expires, and the state directory holds no "([^"]*)"$/,
  function (this: DriveWorld, file: string) {
    claim(
      /Proton keeps the session until it expires/i.test(answered(this)),
      () => `signing out did not say Proton keeps the session until it expires; it answered:\n${indent(answered(this).trim())}\n${this.whatHappened()}`,
    );
    claim(this.sessionBeforeSignOut, () => `the state directory held no "${file}" before the user signed out.\n${this.whatHappened()}`);
    claim(!existsSync(`${this.dirs.state}/${file}`), () => `the state directory still holds "${file}"`);
  },
);

Then(
  /^the state directory holds "([^"]*)" with mode (0[0-7]{3}), and the state directory has mode (0[0-7]{3})$/,
  function (this: DriveWorld, file: string, fileMode: string, dirMode: string) {
    const signIn = this.signIns.at(-1);
    claim(signIn, () => `the user did not sign in.\n${this.whatHappened()}`);
    claim(signIn.ending?.code === 0, () => `signing in did not exit 0.\n${this.whatHappened()}`);
    const path = `${this.dirs.state}/${file}`;
    claim(existsSync(path), () => `the state directory holds no "${file}" after the user signed in.\n${this.whatHappened()}`);
    const modeOf = (each: string) => `0${(statSync(each).mode & 0o777).toString(8).padStart(3, "0")}`;
    claim(modeOf(path) === fileMode, () => `"${file}" has mode ${modeOf(path)}, not ${fileMode}`);
    claim(modeOf(this.dirs.state) === dirMode, () => `the state directory has mode ${modeOf(this.dirs.state)}, not ${dirMode}`);
  },
);

// --- the needs-login status and the state lock --------------------------------------------------

Then(/^the serve exits (\d+) saying "(.*)"$/, async function (this: DriveWorld, code: string, text: string) {
  const serve = this.serve?.process;
  claim(serve, () => `no serve was started.\n${this.whatHappened()}`);
  await serve.waitForEnd(10_000);
  claim(serve.ending, () => `the serve was still running 10 s after the last step.\n${this.whatHappened()}`);
  claim(serve.output.includes(text), () => `the serve did not say "${text}".\n${this.whatHappened()}`);
  claim(serve.ending.code === Number(code), () => `the serve said "${text}" but did not exit ${code}.\n${this.whatHappened()}`);
});

/** The serve's process id, after a claim that the serve ran. */
function servePid(world: DriveWorld): number {
  const pid = world.serve?.process.pid;
  claim(pid !== undefined, () => `the serve has no process id.\n${world.whatHappened()}`);
  return pid;
}

Then(/^signing in exits non-zero, naming the serve's process id, while the serve still answers$/, async function (this: DriveWorld) {
  const signIn = this.signInAttempt;
  claim(signIn, () => `the user did not try to sign in.\n${this.whatHappened()}`);
  const pid = servePid(this);
  claim(this.signInAttemptEnded && signIn.ending, () => `signing in did not end on its own.\n${this.whatHappened()}`);
  claim(signIn.ending.code !== 0, () => `signing in exited 0.\n${this.whatHappened()}`);
  claim(new RegExp(`\\b${pid}\\b`).test(signIn.output), () => `signing in did not name the serve's process id ${pid}.\n${this.whatHappened()}`);
  claim(await this.serveAnswers(), () => `the serve no longer answers.\n${this.whatHappened()}`);
});

Then(
  /^signing out exits non-zero, naming the serve's process id, and the state directory still holds "([^"]*)"$/,
  function (this: DriveWorld, file: string) {
    const answer = this.lastAnswer();
    const pid = servePid(this);
    claim(answer.exitCode !== 0, () => `signing out exited 0; it answered:\n${indent(answered(this).trim())}\n${this.whatHappened()}`);
    claim(new RegExp(`\\b${pid}\\b`).test(answered(this)), () => `signing out did not name the serve's process id ${pid}; it answered:\n${indent(answered(this).trim())}`);
    claim(existsSync(`${this.dirs.state}/${file}`), () => `the state directory no longer holds "${file}"`);
  },
);
