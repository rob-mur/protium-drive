// The Whens and Thens of other programs on the same machine: a web page that reached the port by
// DNS rebinding, a program without the mount's or the serve's credential, and a program that reads `ps`.
import { Then, When } from "@cucumber/cucumber";

import { statSync } from "node:fs";

import type { CallCounts } from "../support/send/control.ts";
import { claim } from "./claims.ts";
import type { DriveWorld, LocalRequestRecord } from "./world.ts";

/** The variable rclone's webdav backend reads its bearer token from (`rclone help backend webdav`). */
const RCLONE_TOKEN = "RCLONE_WEBDAV_BEARER_TOKEN";

When(/^a web page at evil\.example lists "([^"]*)" through the serve's port$/, async function (this: DriveWorld, path: string) {
  await this.listAsForeignSite(path);
});

When(/^another program lists "([^"]*)" at the mount's port without the mount's credential$/, async function (this: DriveWorld, path: string) {
  await this.listAtMountWithoutCredential(path);
});

When(/^another program lists "([^"]*)" at the serve's port without the serve's credential$/, async function (this: DriveWorld, path: string) {
  await this.listAtServeWithoutCredential(path);
});

When(/^another program lists "([^"]*)" at the serve's port with a wrong credential$/, async function (this: DriveWorld, path: string) {
  await this.listAtServeWithWrongCredential(path);
});

When(/^another program reads the mount's processes from the process table$/, async function (this: DriveWorld) {
  await this.readMountProcesses();
});

When(/^another program reads which addresses the serve's port listens on$/, async function (this: DriveWorld) {
  await this.readServeListeningAddresses();
});

Then(/^the serve refuses the web page as misdirected, and the Drive did not list "([^"]*)"$/, function (this: DriveWorld, folder: string) {
  refusedBeforeTheDrive(this, 421, folder);
});

Then(/^the mount's port refuses the program as unauthorised, and the Drive did not list "([^"]*)"$/, function (this: DriveWorld, folder: string) {
  refusedBeforeTheDrive(this, 401, folder);
});

Then(/^the serve's port refuses the program as unauthorised, and the Drive did not list "([^"]*)"$/, function (this: DriveWorld, folder: string) {
  refusedBeforeTheDrive(this, 401, folder);
});

Then(/^rclone holds the mount's credential in its environment, and no command line of the mount's processes holds it$/, function (this: DriveWorld) {
  const processes = this.mountProcesses;
  claim(processes?.length, () => `no process of the mount was read.\n${this.whatHappened()}`);
  const rclone = processes.find((each) => each.env[RCLONE_TOKEN]);
  claim(rclone, () => `no process of the mount holds ${RCLONE_TOKEN} in its environment; the processes were:\n${processes.map((each) => `  ${each.pid}: ${each.argv.join(" ")}`).join("\n")}\n${this.whatHappened()}`);
  const credential = rclone.env[RCLONE_TOKEN]!;
  const showing = processes.filter((each) => each.argv.some((arg) => arg.includes(credential)));
  claim(showing.length === 0, () => `the credential is on the command line of process(es) ${showing.map((each) => each.pid).join(", ")}`);
});

Then(/^the serve's port listens on ([0-9.]+) and on no other address$/, function (this: DriveWorld, address: string) {
  const addresses = this.serveListensOn;
  claim(addresses, () => `no other program read the serve's port.\n${this.whatHappened()}`);
  claim(addresses.includes(address), () => `the serve's port does not listen on ${address}.\n${this.whatHappened()}`);
  const others = addresses.filter((each) => each !== address);
  claim(others.length === 0, () => `the serve's port also listens on ${others.join(", ")}.\n${this.whatHappened()}`);
});

Then(/^the serve's port answers the program with the listing of "([^"]*)"$/, function (this: DriveWorld, folder: string) {
  const request: LocalRequestRecord | undefined = this.localRequests.at(-1);
  claim(request, () => `no other program sent a request.\n${this.whatHappened()}`);
  claim(request.answer.status === 207, () => `${request.who} got ${request.answer.status ?? "no answer"}, not 207.\n${this.whatHappened()}`);
  const uid = this.uids.get(folder);
  claim(uid, () => `the arranged Drive has no folder "${folder}".\n${this.whatHappened()}`);
  claim(request.callsBefore && request.callsAfter, () => `the Drive's calls could not be read.\n${this.whatHappened()}`);
  const listed = (calls: CallCounts) => calls.listings[uid] ?? 0;
  claim(listed(request.callsAfter) > listed(request.callsBefore), () => `the Drive did not list "${folder}" for ${request.who}.\n${this.whatHappened()}`);
});

Then(/^the serve made a credential in its state folder, in a file only the user can read$/, async function (this: DriveWorld) {
  const serve = this.serve;
  claim(serve, () => `the serve was never started.\n${this.whatHappened()}`);
  claim(serve.process.running, () => `the serve is not running.\n${this.whatHappened()}`);
  const path = this.madeCredentialPath();
  let mode: number | undefined;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    mode = undefined;
  }
  claim(mode !== undefined, () => `the serve made no file ${path}.\n${this.whatHappened()}`);
  claim(mode === 0o600, () => `the serve's credential file has mode ${mode!.toString(8)}, not 600.\n${this.whatHappened()}`);
  claim((serve.credential ?? "").length >= 32, () => `the serve's credential file holds no credential of 32 characters or more.\n${this.whatHappened()}`);
  claim(serve.process.output.includes(path), () => `the serve did not tell the user where its credential is (${path}).\n${this.whatHappened()}`);
});

function refusedBeforeTheDrive(world: DriveWorld, status: number, folder: string): void {
  const request: LocalRequestRecord | undefined = world.localRequests.at(-1);
  claim(request, () => `no other program sent a request.\n${world.whatHappened()}`);
  claim(request.answer.status === status, () => `${request.who} got ${request.answer.status ?? "no answer"}, not ${status}.\n${world.whatHappened()}`);
  const uid = world.uids.get(folder);
  claim(uid, () => `the arranged Drive has no folder "${folder}".\n${world.whatHappened()}`);
  claim(request.callsBefore && request.callsAfter, () => `the Drive's calls could not be read.\n${world.whatHappened()}`);
  const listed = (calls: CallCounts) => calls.listings[uid] ?? 0;
  claim(listed(request.callsAfter) === listed(request.callsBefore), () => `the Drive listed "${folder}" for ${request.who}`);
}
