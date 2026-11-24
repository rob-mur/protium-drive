import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import type { DriveWorld } from "./world.ts";

Given(/^the protium-drive binary built from the deployed revision$/, function (this: DriveWorld) {
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

// A build from a git checkout has no release stamp, so its revision takes the place of the version.
Then(/^the first line of the answer is "([^"]*)" and the revision it was built from$/, function (this: DriveWorld, name: string) {
  const answer = this.lastAnswer();
  assert.equal(answer.exitCode, 0, `--version exited ${answer.exitCode}: ${answer.stderr}`);
  const first = answer.stdout.split("\n")[0];
  assert.equal(first, `${name} ${this.binary.revision}`, `--version answered '${answer.stdout.trim()}'`);
});

Then(/^the package's bin folder holds the executable "([^"]*)"$/, function (this: DriveWorld, name: string) {
  assert.ok(this.binary.installs(name), `the bin folder of ${this.binary.path} holds no executable "${name}"`);
});

Then(/^the first line of the help names "([^"]*)"$/, function (this: DriveWorld, name: string) {
  const answer = this.lastAnswer();
  assert.equal(answer.exitCode, 0, `--help exited ${answer.exitCode}: ${answer.stderr}`);
  const first = answer.stdout.split("\n")[0];
  assert.ok(first.startsWith(`${name}:`), `the help's first line is '${first}', which does not name ${name}`);
});
