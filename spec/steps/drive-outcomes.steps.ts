// The Thens about what the Drive holds after the user changed it. Each reads the Drive through
// the Receive arm's control channel, polling with a bound: the serve may answer a write before
// the Drive shows it.
import { Then } from "@cucumber/cucumber";

import type { Control } from "../support/send/control.ts";
import { decode, drive } from "./claims.ts";
import type { DriveWorld } from "./world.ts";

/** Why the Drive does not hold `path` containing `text` outside the trash, or undefined. */
async function holdsContaining(control: Control, path: string, text: string): Promise<string | undefined> {
  const node = await control.nodeIfAny(path);
  if (!node) return `the Drive holds no "${path}" outside the trash`;
  if (node.type !== "file") return `"${path}" is a ${node.type}`;
  const content = decode(await control.content(path));
  return content === text ? undefined : `"${path}" contains "${content}", not "${text}"`;
}

// --- the mount ----------------------------------------------------------------------------------

Then(/^within (\d+) seconds the Drive holds "([^"]*)" containing "([^"]*)"$/, async function (this: DriveWorld, seconds: string, path: string, text: string) {
  await drive(this, (control) => holdsContaining(control, path, text), Number(seconds) * 1000);
});
