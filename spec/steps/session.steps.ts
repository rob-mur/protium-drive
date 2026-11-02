// The Thens about signing in, the sign-in status, signing out and the session's refreshes.
import { existsSync } from "node:fs";

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
