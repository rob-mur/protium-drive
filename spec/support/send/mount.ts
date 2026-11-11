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
  return mountIds(mountpoint).length > 0;
}

/** The ids of the mounts at `mountpoint`, as `/proc/self/mountinfo` lists them. */
export function mountIds(mountpoint: string): string[] {
  let table: string;
  try {
    table = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return [];
  }
  // Field 1 is the mount id; field 5 is the mount point, with a space written as \040.
  return table
    .split("\n")
    .map((line) => line.split(" "))
    .filter((fields) => fields[4]?.replace(/\\040/g, " ") === mountpoint)
    .map((fields) => fields[0]!);
}

const KILLED_MOUNT_MS = 30_000;

/**
 * Leaves `mountpoint` as a mount whose process was killed leaves it: still in the mount table,
 * with every call on it failing "Transport endpoint is not connected". It mounts an empty
 * in-memory remote with stock rclone and kills rclone with SIGKILL, so nothing unmounts.
 * Gives the ids of the dead mount, or what went wrong.
 */
export async function leaveKilledMount(mountpoint: string): Promise<{ ids: string[] } | { failure: string }> {
  const executable = process.env.PDM_RCLONE || "rclone";
  const command = `${executable} mount :memory: ${mountpoint}`;
  const child = spawn(executable, ["mount", ":memory:", mountpoint], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  const ended = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      stderr += `could not start: ${error.message}`;
      resolve();
    });
    child.once("close", () => resolve());
  });
  let running = true;
  void ended.then(() => (running = false));
  const deadline = Date.now() + KILLED_MOUNT_MS;
  while (running && !isMounted(mountpoint) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const mounted = isMounted(mountpoint);
  child.kill("SIGKILL");
  await ended;
  if (!mounted) return { failure: `${command} mounted nothing within ${KILLED_MOUNT_MS / 1000} s: ${stderr}` };
  return { ids: mountIds(mountpoint) };
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
