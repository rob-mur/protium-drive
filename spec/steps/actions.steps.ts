// The Whens: what the user, another client of the Drive, and time do. Each acts and records
// through the World, and asserts nothing.
import { When } from "@cucumber/cucumber";

import type { DriveWorld } from "./world.ts";

// --- the user's account -------------------------------------------------------------------

When(/^the user signs out$/, async function (this: DriveWorld) {
  await this.signOut();
});

When(/^the user tries to sign in again$/, async function (this: DriveWorld) {
  await this.trySigningIn();
});

// --- the serve ------------------------------------------------------------------------------

When(/^the user starts the serve$/, async function (this: DriveWorld) {
  await this.startServe();
});

When(/^the access token expires$/, async function (this: DriveWorld) {
  await this.expireAccessToken();
});

// --- a WebDAV client ------------------------------------------------------------------------

When(/^the user lists "([^"]*)"(?: again)?$/, async function (this: DriveWorld, path: string) {
  await this.list(path);
});

When(/^the user reads "([^"]*)"$/, async function (this: DriveWorld, path: string) {
  await this.read(path);
});

When(/^the user writes "([^"]*)" to "([^"]*)"$/, async function (this: DriveWorld, content: string, path: string) {
  await this.write(path, content);
});

// --- the migration -------------------------------------------------------------------------

When(/^the user migrates the node keys under "([^"]*)"$/, async function (this: DriveWorld, path: string) {
  await this.migrateNodeKeys(path);
});

// --- the rest of the world ------------------------------------------------------------------

When(/^another client adds the file "([^"]*)" containing "([^"]*)"$/, async function (this: DriveWorld, path: string, content: string) {
  await this.anotherClientAdds(path, content);
});

When(/^another client trashes "([^"]*)"$/, async function (this: DriveWorld, path: string) {
  await this.anotherClientTrashes(path);
});

When(/^(?:the serve reads the Drive's events|the Drive's event scheduler calls the serve)$/, async function (this: DriveWorld) {
  await this.readEvents();
});

When(/^the serve starts and reads the Drive's events (\d+) times$/, async function (this: DriveWorld, times: string) {
  await this.readEvents(Number(times));
});

// --- the mount ------------------------------------------------------------------------------

When(/^the user reads the mounted file "([^"]*)"$/, async function (this: DriveWorld, path: string) {
  await this.readMountedFile(path);
});

When(/^the user mounts the Drive at that folder$/, async function (this: DriveWorld) {
  await this.mountAtFolder();
});

When(/^the user writes "([^"]*)" to the mounted file "([^"]*)"$/, async function (this: DriveWorld, content: string, path: string) {
  await this.writeMountedFile(path, content);
});
