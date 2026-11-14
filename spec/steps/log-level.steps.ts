// The steps about the log level: the option and the variable the user sets it with, what the help
// says of them, and the lines the serve, the mount and the rclone it runs write to stderr.
import { Given, Then, When } from "@cucumber/cucumber";

import { Control } from "../support/send/control.ts";
import { claim, last, succeeded } from "./claims.ts";
import { type DriveWorld, LOG_LEVEL_FLAG, LOG_LEVEL_VARIABLE } from "./world.ts";

/** The levels the user can give, lowest first. */
const LEVELS = ["debug", "info", "warn", "error"];
/** What the mount puts before each line rclone writes. */
const RCLONE_MARK = "rclone: ";
/** How long a Then waits for the mount to write the lines it looks for. */
const LINES_MS = 30_000;

/** A line as rclone logs it: date, time, level, then a colon. */
const RCLONE_LINE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? ([A-Z]+) ?: /;

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\r$/, ""));
}

/** The level of each line rclone logged, marked or not. */
function rcloneLines(stderr: string): { line: string; level: string; marked: boolean }[] {
  return lines(stderr).flatMap((line) => {
    const marked = line.startsWith(RCLONE_MARK);
    const level = RCLONE_LINE.exec(marked ? line.slice(RCLONE_MARK.length) : line)?.[1];
    return level === undefined ? [] : [{ line, level, marked }];
  });
}

/** The lines the binary itself logged at `level`. */
function ownLines(stderr: string, level: string): string[] {
  return lines(stderr).filter((line) => line.startsWith(`${level}: `));
}

/** The section of the help that starts at the line `heading`, up to the next heading. */
function section(help: string, heading: string): string | undefined {
  const all = lines(help);
  const start = all.indexOf(heading);
  if (start < 0) return undefined;
  const end = all.findIndex((line, i) => i > start && /^\S/.test(line));
  return all.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

// --- Givens ---------------------------------------------------------------------------------------

Given(/^the user mounts the Drive at a folder with the log level "([^"]*)"$/, function (this: DriveWorld, level: string) {
  this.mounted = true;
  this.logLevel = level;
});

Given(/^the environment the user mounts the Drive in sets PDM_LOG_LEVEL to "([^"]*)"$/, function (this: DriveWorld, level: string) {
  this.logLevelVariable = level;
});

Given(/^the user serves the Drive with the log level "([^"]*)"$/, function (this: DriveWorld, level: string) {
  this.logLevel = level;
});

// --- Whens ----------------------------------------------------------------------------------------

When(/^the user asks the binary for its help$/, function (this: DriveWorld) {
  this.answer = this.runBinary(["--help"]);
});

// --- Thens ----------------------------------------------------------------------------------------

Then(
  /^the help lists --log-level with the levels debug, info, warn and error, and names PDM_LOG_LEVEL under Environment$/,
  function (this: DriveWorld) {
    const answer = this.lastAnswer();
    claim(answer.exitCode === 0, () => `--help exited ${answer.exitCode}: ${answer.stderr}`);
    const help = answer.stdout;
    const options = section(help, "Options:");
    claim(options, () => `the help has no "Options:" section:\n${help}`);
    const all = lines(options);
    const at = all.findIndex((line) => line.trimStart().startsWith(`${LOG_LEVEL_FLAG} LEVEL`));
    claim(at >= 0, () => `the help's Options do not list "${LOG_LEVEL_FLAG} LEVEL":\n${options}`);
    // The option's entry runs to the next line that starts another entry.
    const next = all.findIndex((line, i) => i > at && /^ {2}\S/.test(line));
    const entry = all.slice(at, next < 0 ? undefined : next).join("\n");
    for (const level of LEVELS) {
      claim(new RegExp(`\\b${level}\\b`).test(entry), () => `the help's entry for ${LOG_LEVEL_FLAG} does not name the level ${level}:\n${entry}`);
    }
    const environment = section(help, "Environment:");
    claim(environment, () => `the help has no "Environment:" section:\n${help}`);
    claim(environment.includes(LOG_LEVEL_VARIABLE), () => `the help's Environment section does not name ${LOG_LEVEL_VARIABLE}:\n${environment}`);
    claim(environment.includes(LOG_LEVEL_FLAG), () => `the help's Environment section does not point at ${LOG_LEVEL_FLAG}:\n${environment}`);
  },
);

Then(/^the mount wrote its own debug lines, and rclone's debug lines each marked "rclone: "$/, async function (this: DriveWorld) {
  const mount = this.mount;
  claim(mount, () => `the mount was never started.\n${this.whatHappened()}`);
  const process = mount.process;
  const markedDebug = () => rcloneLines(process.stderr).some((line) => line.marked && line.level === "DEBUG");
  await process.waitFor(() => markedDebug() && ownLines(process.stderr, "debug").length > 0, LINES_MS);
  claim(markedDebug(), () => `the mount wrote no rclone line at DEBUG marked "${RCLONE_MARK}".\n${this.whatHappened()}`);
  claim(ownLines(process.stderr, "debug").length > 0, () => `the mount wrote no "debug: " line of its own.\n${this.whatHappened()}`);
  const unmarked = rcloneLines(process.stderr).filter((line) => !line.marked);
  claim(unmarked.length === 0, () => `the mount wrote rclone lines without "${RCLONE_MARK}":\n${unmarked.map((l) => l.line).join("\n")}\n${this.whatHappened()}`);
});

Then(
  /^the mount started the serve, and wrote no debug or info lines of its own and no rclone line below ERROR$/,
  function (this: DriveWorld) {
    const mount = this.mount;
    claim(mount, () => `the mount was never started.\n${this.whatHappened()}`);
    const process = mount.process;
    claim(Control.fromOutput(process.output) !== undefined, () => `the mount did not start the serve.\n${this.whatHappened()}`);
    const own = [...ownLines(process.stderr, "debug"), ...ownLines(process.stderr, "info")];
    claim(own.length === 0, () => `the mount wrote debug or info lines of its own:\n${own.join("\n")}\n${this.whatHappened()}`);
    const rclone = rcloneLines(process.stderr);
    const below = rclone.filter((line) => ["DEBUG", "INFO", "NOTICE"].includes(line.level));
    claim(below.length === 0, () => `rclone logged below ERROR:\n${below.map((l) => l.line).join("\n")}\n${this.whatHappened()}`);
    const unmarked = rclone.filter((line) => !line.marked);
    claim(unmarked.length === 0, () => `the mount wrote rclone lines without "${RCLONE_MARK}":\n${unmarked.map((l) => l.line).join("\n")}\n${this.whatHappened()}`);
  },
);

Then(/^the mount exited with status 2, naming "([^"]*)", and served nothing$/, function (this: DriveWorld, value: string) {
  const mount = this.mount;
  claim(mount, () => `the mount was never started.\n${this.whatHappened()}`);
  const ending = mount.process.ending;
  claim(ending, () => `the mount did not end on its own.\n${this.whatHappened()}`);
  claim(ending.code === 2, () => `the mount exited with ${ending.code ?? ending.signal}, not 2.\n${this.whatHappened()}`);
  claim(mount.process.stderr.includes(value), () => `the mount's message does not name "${value}".\n${this.whatHappened()}`);
  claim(Control.fromOutput(mount.process.output) === undefined, () => `the mount started the serve before it refused.\n${this.whatHappened()}`);
});

Then(/^the listing succeeds, and the serve wrote no debug or info lines$/, function (this: DriveWorld) {
  succeeded(this, last(this, "list"));
  const serve = this.serve;
  claim(serve, () => `the serve was never started.\n${this.whatHappened()}`);
  const own = [...ownLines(serve.process.stderr, "debug"), ...ownLines(serve.process.stderr, "info")];
  claim(own.length === 0, () => `the serve wrote debug or info lines:\n${own.join("\n")}\n${this.whatHappened()}`);
});
