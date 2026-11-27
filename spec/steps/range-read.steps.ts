// A read of part of a file, from the middle: the range a video player asks for after a seek.
//
// What it guards: a range that does not start at byte 0 takes the serve's range stream, not the
// verified download of the whole file. The range starts inside the Drive's second 4 MiB block and
// ends in its fifth, so the stream must join blocks and cut the first and last one at the right byte.
// Each block takes the Drive 1 s to give, so a stream that fetches the four blocks one after the
// other takes 4 s or more: on build 441f6d6 the range stream read one block at a time (#164).
import { Given, Then, When } from "@cucumber/cucumber";

import { claim, last } from "./claims.ts";
import type { DriveWorld } from "./world.ts";

/** What each file arranged for a range read holds, by path. */
const contents = new WeakMap<DriveWorld, Map<string, Uint8Array>>();
/** How long the last range read took, from its start to its end, in ms. */
const readMs = new WeakMap<DriveWorld, number>();

/** `size` bytes that differ along the file, so a byte from the wrong place shows. */
function contentOf(path: string, size: number): Uint8Array {
  const content = new Uint8Array(size);
  let state = [...path].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 11);
  for (let i = 0; i < size; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    content[i] = state >>> 24;
  }
  return content;
}

/** The first byte where `got` and `want` differ, or -1 when they are the same. */
function firstDifference(got: Uint8Array, want: Uint8Array): number {
  const length = Math.min(got.length, want.length);
  for (let i = 0; i < length; i++) if (got[i] !== want[i]) return i;
  return got.length === want.length ? -1 : length;
}

Given(/^the Drive's My files holds the (\d+) MiB file "([^"]*)"$/, function (this: DriveWorld, mebibytes: string, path: string) {
  const content = contentOf(path, Number(mebibytes) * 1024 * 1024);
  this.seed.file(path, { content, mediaType: "video/x-matroska" });
  const known = contents.get(this) ?? new Map<string, Uint8Array>();
  known.set(path, content);
  contents.set(this, known);
});

Given(/^the Drive takes (\d+) seconds? to give each 4 MiB block a read of a file fetches$/, function (this: DriveWorld, seconds: string) {
  this.seed.blockFetchMs = Number(seconds) * 1000;
});

When(/^the user reads (\d+) bytes of "([^"]*)" from byte (\d+)$/, async function (this: DriveWorld, count: string, path: string, offset: string) {
  // The serve starts before the clock does, so the time is the read's alone.
  await this.ensureServing();
  const began = performance.now();
  await this.read(path, { offset: Number(offset), count: Number(count) });
  readMs.set(this, performance.now() - began);
});

Then(
  /^the serve answered the read as partial content, and the read gives the file's bytes from (\d+) to (\d+) within ([\d.]+) seconds$/,
  function (this: DriveWorld, first: string, lastByte: string, seconds: string) {
    const read = last(this, "read");
    claim(read.outcome.exitCode === 0, () => `the read of "${read.path}" failed.\n${this.whatHappened()}`);
    const gets = read.outcome.exchanges.filter((exchange) => exchange.method === "GET");
    claim(
      gets.length > 0 && gets.every((get) => get.status === 206),
      () => `the serve answered the read's GETs with ${gets.map((get) => get.status).join(", ") || "nothing"}, not 206.\n${this.whatHappened()}`,
    );
    const content = contents.get(this)?.get(read.path);
    claim(content, () => `the scenario arranged no content for "${read.path}"`);
    const want = content.subarray(Number(first), Number(lastByte) + 1);
    const got = read.outcome.stdout;
    claim(got.length === want.length, () => `the read gave ${got.length} bytes, not ${want.length}.\n${this.whatHappened()}`);
    const differs = firstDifference(got, want);
    claim(differs === -1, () => `the read's byte ${differs} is not the file's byte ${Number(first) + differs}.\n${this.whatHappened()}`);
    const ms = readMs.get(this);
    claim(ms !== undefined, () => "the scenario timed no read");
    claim(ms <= Number(seconds) * 1000, () => `the read took ${(ms / 1000).toFixed(2)} s, not ${seconds} s or less.\n${this.whatHappened()}`);
  },
);
