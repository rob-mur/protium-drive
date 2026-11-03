// The Thens about node keys: what the Drive holds after `migrate-node-keys`.
// Each reads the Drive through the Receive arm's control channel, once: the command has ended
// by the time a Then runs.
import { Then } from "@cucumber/cucumber";

import type { Control } from "../support/send/control.ts";
import { claim, decode, drive } from "./claims.ts";
import { CLAIMED_MODIFICATION_TIME } from "./drive.steps.ts";
import type { DriveWorld } from "./world.ts";

/** The migration the When ran, after a claim that it ended well. */
function migrated(world: DriveWorld): void {
  const migration = world.migration;
  claim(migration, () => `no node keys were migrated.\n${world.whatHappened()}`);
  claim(
    migration.answer.exitCode === 0,
    () => `migrating the node keys under "${migration.path}" failed (the command may not exist): exit ${migration.answer.exitCode}\n${migration.answer.stderr}\n${world.whatHappened()}`,
  );
}

/** Why the Drive does not hold `path` as a file with `text`, a v4 node key and the claimed modification time, or undefined. */
async function holdsMigrated(control: Control, path: string, text: string): Promise<string | undefined> {
  const node = await control.nodeIfAny(path);
  if (!node) return `the Drive holds no "${path}" outside the trash`;
  if (node.type !== "file") return `"${path}" is a ${node.type}`;
  const content = decode(await control.content(path));
  if (content !== text) return `"${path}" contains "${content}", not "${text}"`;
  if (node.nodeKeyVersion !== 4) return `"${path}" has a version ${node.nodeKeyVersion} node key, not 4`;
  if (node.claimedModificationTime !== CLAIMED_MODIFICATION_TIME) {
    return `"${path}" claims the modification time ${node.claimedModificationTime}, not ${CLAIMED_MODIFICATION_TIME}`;
  }
  return undefined;
}

Then(
  /^"([^"]*)" contains "([^"]*)", has a v4 node key and keeps its modification time$/,
  async function (this: DriveWorld, path: string, text: string) {
    migrated(this);
    await drive(this, (control) => holdsMigrated(control, path, text));
  },
);

Then(/^the Drive's trash holds the old "([^"]*)"$/, async function (this: DriveWorld, name: string) {
  const old = [...this.uids].filter(([path]) => path === name || path.endsWith(`/${name}`));
  claim(old.length === 1, () => `the scenario arranged ${old.length} files called "${name}", not one.`);
  const [path, uid] = old[0]!;
  await drive(this, async (control) => {
    const trashed = await control.trashed();
    return trashed.some((node) => node.uid === uid) ? undefined : `the trash holds ${JSON.stringify(trashed.map((node) => node.path))}, not the old "${path}" (${uid})`;
  });
});

Then(/^"([^"]*)" is the same node as before$/, async function (this: DriveWorld, path: string) {
  const uid = this.uids.get(path);
  claim(uid, () => `the scenario arranged no "${path}".`);
  await drive(this, async (control) => {
    const node = await control.nodeIfAny(path);
    if (!node) return `the Drive holds no "${path}" outside the trash`;
    return node.uid === uid ? undefined : `"${path}" is now the node ${node.uid}, not ${uid}`;
  });
});
