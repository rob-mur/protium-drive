// What the Thens share: how a claim fails, and how they read what the Whens recorded.
import assert from "node:assert/strict";

import type { Control } from "../support/send/control.ts";
import { describe, entries, type Entry, type Outcome, refusal } from "../support/send/rclone.ts";
import type { Action, DriveWorld } from "./world.ts";

/** Fails the step with `message` unless `condition` holds. */
export function claim(condition: unknown, message: () => string): asserts condition {
  if (!condition) assert.fail(message());
}

export function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

/** The last action of `kind`, or a failed claim that there was none. */
export function last(world: DriveWorld, kind: Action["kind"]): Action {
  const action = world.actionsOf(kind).at(-1);
  claim(action, () => `no ${kind} was recorded.\n${world.whatHappened()}`);
  return action;
}

export interface Row {
  name: string;
  kind: string;
  size: string;
}

/** The rows a listing showed, after a claim that it succeeded. */
export function rowsOf(world: DriveWorld, action: Action): Row[] {
  const listed = succeeded(world, action);
  return listed.map((entry) => ({ name: entry.Name, kind: entry.IsDir ? "folder" : "file", size: entry.IsDir ? "" : String(entry.Size) }));
}

/** The entries of a listing, after a claim that it succeeded. */
export function succeeded(world: DriveWorld, action: Action): Entry[] {
  claim(action.outcome.exitCode === 0, () => `the ${action.kind} of "${action.path}" failed:\n${describe(action.outcome)}\n${world.whatHappened()}`);
  const listed = entries(action.outcome);
  claim(listed, () => `the listing of "${action.path}" gave no entries:\n${describe(action.outcome)}`);
  return listed;
}

/** Claims that a listing showed exactly `want`, in any order. */
export function showsExactly(world: DriveWorld, action: Action, want: Row[]): void {
  const order = (rows: Row[]) => rows.map((row) => `${row.name} | ${row.kind} | ${row.size}`).sort();
  const got = rowsOf(world, action);
  assert.deepEqual(order(got), order(want), `the listing of "${action.path}" showed other entries than these`);
}

/**
 * Claims that the server refused the last `method` of `outcome` with `status` (and the
 * `Retry-After` given), and that the client reported a failure.
 */
export function refusedWith(world: DriveWorld, action: Action, method: string, status: number, retryAfter?: number): void {
  const refused = refusal(action.outcome, method);
  claim(
    refused?.status === status,
    () => `the ${action.kind} of "${action.path}" was not refused with ${status}:\n${describe(action.outcome)}\n${world.whatHappened()}`,
  );
  if (retryAfter !== undefined) {
    claim(
      refused.headers["retry-after"] === String(retryAfter),
      () => `the ${action.kind} of "${action.path}" was refused with ${status} but Retry-After ${refused.headers["retry-after"] ?? "missing"}, not ${retryAfter}`,
    );
  }
  claim(action.outcome.exitCode !== 0, () => `the ${action.kind} of "${action.path}" was refused, yet the client reported success:\n${describe(action.outcome)}`);
}

/** Claims that the client's report of a failed action says `text`. */
export function says(action: Action, text: string): void {
  claim(action.outcome.stderr.includes(text), () => `the ${action.kind} of "${action.path}" did not say "${text}":\n${describe(action.outcome)}`);
}

export function output(outcome: Outcome): string {
  return decode(outcome.stdout);
}

/**
 * Claims that `check` passes on the Receive arm's control channel, polling it for up to `ms`
 * (once, when `ms` is 0). `check` gives why it failed, or undefined.
 */
export async function drive(world: DriveWorld, check: (control: Control) => Promise<string | undefined>, ms?: number): Promise<void> {
  const failure = await world.settle(check, ms);
  claim(failure === undefined, () => failure!);
}
