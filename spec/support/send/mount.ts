// The Send arm at the mount point: what a user's programs do with the mounted folder. Each action
// runs in its own process with a bound, so a FUSE call that hangs ends the action rather than the
// suite.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

/** What one action at the mount point did. */
export interface MountOutcome {
  command: string;
  /** -1 when it did not end in time (see `timedOut`) or could not start. */
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
  timedOut: boolean;
}

const ACTION_TIMEOUT_MS = 60_000;

/** Whether a file system is mounted at `mountpoint`, as `/proc/self/mountinfo` says. */
export function isMounted(mountpoint: string): boolean {
  let table: string;
  try {
    table = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return false;
  }
  // Field 5 is the mount point, with a space written as \040.
  return table.split("\n").some((line) => line.split(" ")[4]?.replace(/\\040/g, " ") === mountpoint);
}

/** The content of the file at `path`. */
export function readMounted(path: string): Promise<MountOutcome> {
  return run("cat", ["--", path]);
}

/** The names in the folder at `path`, one per line. */
export function listMounted(path: string): Promise<MountOutcome> {
  return run("ls", ["-A1", "--", path]);
}

/** Writes `content` to the file at `path`, as a program that copies a file in does. */
export function writeMounted(path: string, content: Uint8Array): Promise<MountOutcome> {
  return run("sh", ["-c", 'cat > "$1"', "sh", path], content);
}

/** Unmounts `mountpoint` lazily, for the cleanup after a scenario; it reports nothing. */
export function unmount(mountpoint: string): Promise<MountOutcome> {
  return run("fusermount3", ["-u", "-z", mountpoint]);
}

function run(executable: string, args: string[], stdin?: Uint8Array): Promise<MountOutcome> {
  const command = [executable, ...args].join(" ");
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, ACTION_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    if (stdin && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      resolve({ command, exitCode, stdout: new Uint8Array(Buffer.concat(stdout)), stderr, timedOut });
    };
    child.on("error", (error) => {
      stderr += `${command} could not start: ${error.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(timedOut ? -1 : (code ?? -1)));
  });
}
