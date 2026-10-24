import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import type { DriveWorld } from "./world.ts";

Given(/^the proton-drive-mount binary built from the deployed revision$/, function (this: DriveWorld) {
  assert.ok(this.binary.isExecutable(), `${this.binary.path} is not an executable file`);
});

When(/^the user asks the binary for its version$/, function (this: DriveWorld) {
  this.answer = this.binary.run(["--version"]);
});

Then(/^the answer names the revision the binary was built from$/, function (this: DriveWorld) {
  const answer = this.lastAnswer();
  assert.equal(answer.exitCode, 0, `--version exited ${answer.exitCode}: ${answer.stderr}`);
  assert.match(
    answer.stdout,
    new RegExp(`\\b${this.binary.revision}\\b`),
    `--version answered '${answer.stdout.trim()}', which does not name ${this.binary.revision}`,
  );
});
