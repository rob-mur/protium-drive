// The DSL layer's World: the one object every step definition reaches the product through.
// Steps speak the project's words and call the Send arm modules under spec/support/send/;
// they never name a command line, a port or a protocol themselves.
//
// The rules the steps keep (rob/continuous-delivery#657):
// - A Given arranges data on this World only: the Drive, the account, the faults. It starts no
//   process and calls no control channel.
// - A When acts and records what happened, and asserts nothing: it never throws. The first When
//   that needs the product writes the arranged Drive, signs the user in (unless a Given says they
//   have not) and starts the serve on it. A binary that does not start is a recorded outcome.
// - The one Then of a scenario asserts all it claims, positive evidence first. A Then that reads
//   the Drive after a write polls the control channel with a bound; nothing sleeps.
import { answersHttp, freePort, poll } from "@cd-pipeline/support";
import { After, type IWorldOptions, setDefaultTimeout, setWorldConstructor, World } from "@cucumber/cucumber";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DriveSeed, parentOf } from "../support/drive-seed.ts";
import { type Answer, Binary, type Home, indent, type Running } from "../support/send/binary.ts";
import { type CallCounts, Control, type Fault } from "../support/send/control.ts";
import { isMounted, leaveKilledMount, listMounted, mountIds, type MountOutcome, readMounted, unmount, writeMounted } from "../support/send/mount.ts";
import { describe as describeOutcome, type Outcome, Rclone, refusal } from "../support/send/rclone.ts";
import { propfindWholeTree, type RawAnswer } from "../support/send/webdav.ts";

// A listing of 5000 photos through a cold serve, or a mount, takes a while.
setDefaultTimeout(300_000);

/** How long a process of the binary gets to start, or to end on its own. */
const START_MS = 30_000;
/** How long the binary gets to mount the Drive. */
const MOUNT_MS = 60_000;
/** How long a Then waits for the Drive to show a write the serve has answered. */
const SETTLE_MS = 10_000;

/** The scenario's own directories, under one temporary directory. */
interface Scratch {
  root: string;
  /** The Receive arm's `DIR`: the Drive and the account. */
  drive: string;
  /** `--state-dir`: not created here, so the binary creates it with its own mode. */
  state: string;
  home: Home;
  mountpoint: string;
}

/** A running serve, or the serve a mount runs. */
export interface Serving {
  process: Running;
  url: string;
  /** The Receive arm's control channel, once the process has printed it. */
  control?: Control;
}

export type ActionKind = "list" | "stat" | "read" | "write" | "delete" | "make folder" | "remove folder" | "move";

/** One thing the user did through a WebDAV client, with the Drive's calls before and after it. */
export interface Action {
  kind: ActionKind;
  path: string;
  outcome: Outcome;
  callsBefore?: CallCounts;
  callsAfter?: CallCounts;
}

/** One poll of the Drive's event scheduler. */
export interface EventRead {
  /** The scopes the scheduler polled; undefined when the poll failed. */
  scopes?: string[];
  callsBefore?: CallCounts;
  callsAfter?: CallCounts;
}

export class DriveWorld extends World {
  readonly binary: Binary;
  answer?: Answer;

  // --- what the Givens arrange ------------------------------------------------
  readonly seed = new DriveSeed();
  signedIn = true;
  readonly faults: Fault[] = [];
  refusesNextRefresh = false;
  root?: string;
  host?: string;
  /** The user reaches the Drive through a mount; the first When at the mount point mounts it. */
  mounted = false;
  /** The folder the user mounts the Drive at, before the mount: an empty folder unless a Given says otherwise. */
  mountFolder: { kind: "empty" } | { kind: "missing" } | { kind: "left mounted" } | { kind: "holds"; file: string } = { kind: "empty" };

  // --- what the Whens record --------------------------------------------------
  /** The UID of each node the arranged Drive held, by path. */
  uids = new Map<string, string>();
  /** The sign-in the arrangement made, for a scenario where the user has signed in. */
  setupSignIn?: Running;
  /** The sign-ins a When made, last last. */
  readonly signIns: Running[] = [];
  /** A sign-in a When started and stopped once it printed its URL. */
  startedSignIn?: Running;
  /** Whether the state directory held a session just before the user signed out. */
  sessionBeforeSignOut?: boolean;
  serve?: Serving;
  secondServe?: Running;
  mount?: Serving & { mountpoint: string };
  readonly actions: Action[] = [];
  readonly eventReads: EventRead[] = [];
  wholeTree?: { answer: RawAnswer; callsBefore?: CallCounts; callsAfter?: CallCounts };
  mountedRead?: { file: MountOutcome; folder: MountOutcome };
  mountedWrite?: MountOutcome;
  /** A `mount` a When ran to its end, and what the folder held after it. */
  mountRun?: { answer: Answer; folderAfter?: string[] };
  /** The `migrate-node-keys` run a When made. */
  migration?: { path: string; answer: Answer };
  /** What went wrong while acting, for the Then's failure message. */
  readonly troubles: string[] = [];

  private scratch?: Scratch;
  private arranged = false;
  private faultsSet = false;
  private readonly processes: Running[] = [];
  /** The ids of the dead mounts the arranged folder was left with; a new mount is any other. */
  private deadMounts?: string[];

  constructor(options: IWorldOptions) {
    super(options);
    this.binary = Binary.fromEnvironment();
  }

  lastAnswer(): Answer {
    if (!this.answer) throw new Error("no step has asked the binary anything yet");
    return this.answer;
  }

  get dirs(): Scratch {
    if (!this.scratch) {
      const root = mkdtempSync(join(tmpdir(), "pdm-spec-"));
      const home = join(root, "home");
      mkdirSync(home);
      this.scratch = { root, drive: join(root, "drive"), state: join(root, "state"), home: { home }, mountpoint: join(root, "mnt") };
    }
    return this.scratch;
  }

  // --- the binary's own commands ----------------------------------------------

  /** Runs a command of the binary that ends on its own, in the scenario's home. Never throws. */
  runBinary(args: string[]): Answer {
    try {
      return this.binary.run(args, this.dirs.home);
    } catch (error: unknown) {
      return { exitCode: -1, stdout: "", stderr: `'proton-drive-mount ${args.join(" ")}' did not run: ${String(error)}` };
    }
  }

  private start(args: string[]): Running {
    const running = this.binary.start(args, this.dirs.home);
    this.processes.push(running);
    return running;
  }

  private signInArgs(): string[] {
    return ["auth", "login", "--state-dir", this.dirs.state, "--fake-drive", this.dirs.drive];
  }

  /** `auth login`, approved through the Receive arm's account as the user approves it in a browser. */
  async signIn(): Promise<Running> {
    const running = this.start(this.signInArgs());
    await running.waitFor((p) => Control.fromOutput(p.output) !== undefined, START_MS);
    const control = Control.fromOutput(running.output);
    if (!control) {
      this.trouble(`signing in printed no control channel: ${running.describe()}`);
      if (running.running) await running.stop();
      return running;
    }
    const waits = await running.waitFor(async () => ((await quietly(() => control.account()))?.signIns.pending ?? 0) >= 1, START_MS);
    if (waits) await this.attempt("approving the sign-in", () => control.approveSignIn());
    else this.trouble(`no sign-in waited for an approval: ${running.describe()}`);
    if (!(await running.waitForEnd(START_MS))) {
      this.trouble(`signing in did not end within ${START_MS / 1000} s of the approval`);
      await running.stop();
    }
    return running;
  }

  /** Starts `auth login`, keeps what it prints until it prints a URL, and stops it there. */
  async startSigningIn(): Promise<void> {
    await this.arrange();
    const running = this.start(this.signInArgs());
    await running.waitFor((p) => /https:\/\/\S+/.test(p.output), START_MS);
    this.startedSignIn = running;
    await running.stop();
  }

  async signInAgain(): Promise<void> {
    await this.arrange();
    this.signIns.push(await this.signIn());
  }

  async askStatus(): Promise<void> {
    await this.arrange();
    this.answer = this.runBinary(["auth", "status", "--state-dir", this.dirs.state]);
  }

  async signOut(): Promise<void> {
    await this.arrange();
    this.sessionBeforeSignOut = existsSync(this.sessionFile());
    this.answer = this.runBinary(["auth", "logout", "--state-dir", this.dirs.state]);
  }

  sessionFile(): string {
    return join(this.dirs.state, "session.json");
  }

  /** The access and refresh tokens the Receive arm's account issued (fake-drive/account.ts, `AccountState`). */
  issuedTokens(): string[] {
    try {
      const account = JSON.parse(readFileSync(join(this.dirs.drive, "account.json"), "utf8")) as {
        sessions?: Record<string, { accessToken: string; refreshToken: string }>;
      };
      return Object.values(account.sessions ?? {}).flatMap((session) => [session.accessToken, session.refreshToken]);
    } catch {
      return [];
    }
  }

  // --- the serve ---------------------------------------------------------------

  /**
   * The first When that needs the product: writes the arranged Drive, then signs the user in
   * unless a Given said they have not.
   */
  private async arrange(): Promise<void> {
    if (this.arranged) return;
    this.arranged = true;
    try {
      this.uids = this.seed.write(this.dirs.drive);
    } catch (error: unknown) {
      this.trouble(`the arranged Drive could not be written: ${String(error)}`);
    }
    if (this.signedIn) this.setupSignIn = await this.signIn();
  }

  private serveArgs(port: number): string[] {
    return [
      "serve",
      "--port",
      String(port),
      "--state-dir",
      this.dirs.state,
      "--fake-drive",
      this.dirs.drive,
      ...(this.host ? ["--host", this.host] : []),
      ...(this.root ? ["--root", this.root] : []),
    ];
  }

  /** The serve, started (or started again after it stopped) on the arranged Drive. */
  async ensureServing(): Promise<Serving> {
    await this.arrange();
    if (this.serve?.process.running) return this.serve;
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const running = this.start(this.serveArgs(port));
    const serve: Serving = { process: running, url };
    this.serve = serve;
    if (!(await running.waitFor(() => answersHttp(url), START_MS))) {
      this.trouble(`the serve did not answer on ${url} within ${START_MS / 1000} s: ${running.describe()}`);
    }
    serve.control = Control.fromOutput(running.output);
    await this.setFaults(serve);
    return serve;
  }

  /**
   * Runs `migrate-node-keys` on the Drive under `path`. Starts the serve first, so the Thens have
   * a control channel to read the Drive through; the command and the serve share the Drive.
   */
  async migrateNodeKeys(path: string): Promise<void> {
    await this.ensureServing();
    const answer = this.runBinary(["migrate-node-keys", path, "--state-dir", this.dirs.state, "--fake-drive", this.dirs.drive]);
    this.migration = { path, answer };
  }

  async startServe(host?: string): Promise<void> {
    if (host) this.host = host;
    await this.ensureServing();
  }

  /** A second serve on the same state directory, given the time to start or to give up. */
  async startSecondServe(): Promise<void> {
    await this.arrange();
    const running = this.start(this.serveArgs(await freePort()));
    await running.waitForEnd(START_MS);
    this.secondServe = running;
  }

  async killServe(): Promise<void> {
    await this.serve?.process.kill();
  }

  async restartServe(): Promise<void> {
    await this.serve?.process.stop();
    await this.ensureServing();
  }

  /** Whether the serve is running and answers HTTP. */
  async serveAnswers(): Promise<boolean> {
    return !!this.serve?.process.running && (await answersHttp(this.serve.url));
  }

  /** The arranged faults and the refused refresh, set once, on the first process with a Receive arm. */
  private async setFaults(serving: Serving): Promise<void> {
    if (this.faultsSet || (this.faults.length === 0 && !this.refusesNextRefresh)) return;
    this.faultsSet = true;
    const control = serving.control;
    if (!control) {
      this.trouble("the binary printed no control channel, so the arranged faults were never set");
      return;
    }
    for (const fault of this.faults) await this.attempt(`setting the fault ${JSON.stringify(fault)}`, () => control.addFault(fault));
    if (this.refusesNextRefresh) await this.attempt("making the account refuse the next refresh", () => control.refuseNextRefresh());
  }

  // --- a WebDAV client ------------------------------------------------------------

  private async act(kind: ActionKind, path: string, run: (client: Rclone) => Promise<Outcome>): Promise<Action> {
    const serving = await this.ensureServing();
    const callsBefore = await this.calls(serving);
    const outcome = await run(new Rclone(serving.url));
    const action: Action = { kind, path, outcome, callsBefore, callsAfter: await this.calls(serving) };
    this.actions.push(action);
    return action;
  }

  async list(path: string): Promise<void> {
    await this.act("list", path, (client) => client.list(path));
  }

  /** Lists `path` `times` times; after each refusal, the Receive arm's clock moves on by its `Retry-After`. */
  async listWaitingOutPauses(path: string, times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      const action = await this.act("list", path, (client) => client.list(path));
      if (i === times - 1) break;
      const retryAfter = Number(refusal(action.outcome, "PROPFIND")?.headers["retry-after"]);
      if (Number.isFinite(retryAfter)) await this.pass(retryAfter);
      else this.trouble(`listing ${i + 1} of ${times} gave no Retry-After to wait out`);
    }
  }

  async askAbout(path: string): Promise<void> {
    await this.act("stat", path, (client) => client.stat(path));
  }

  async read(path: string, range?: { offset: number; count: number }): Promise<void> {
    await this.act("read", path, (client) => client.read(path, range));
  }

  async write(path: string, text: string): Promise<void> {
    await this.act("write", path, (client) => client.write(path, new TextEncoder().encode(text)));
  }

  async deleteFile(path: string): Promise<void> {
    await this.act("delete", path, (client) => client.deleteFile(path));
  }

  async makeFolder(path: string): Promise<void> {
    await this.act("make folder", path, (client) => client.makeFolder(path));
  }

  async removeFolder(path: string): Promise<void> {
    await this.act("remove folder", path, (client) => client.removeFolder(path));
  }

  async move(from: string, to: string): Promise<void> {
    await this.act("move", from, (client) => client.move(from, to));
  }

  async askWholeTree(path: string): Promise<void> {
    const serving = await this.ensureServing();
    const callsBefore = await this.calls(serving);
    const answer = await propfindWholeTree(serving.url, path);
    this.wholeTree = { answer, callsBefore, callsAfter: await this.calls(serving) };
  }

  actionsOf(kind: ActionKind): Action[] {
    return this.actions.filter((action) => action.kind === kind);
  }

  // --- the Receive arm, as the rest of the world ---------------------------------

  /** Moves the Receive arm's clock on. */
  async pass(seconds: number): Promise<void> {
    const control = (await this.ensureServing()).control;
    if (control) await this.attempt(`moving the clock on ${seconds} s`, () => control.advanceClock(seconds));
    else this.trouble(`no control channel to move the clock on ${seconds} s`);
  }

  async expireAccessToken(): Promise<void> {
    const control = (await this.ensureServing()).control;
    if (control) await this.attempt("expiring the access token", () => control.expireAccessToken());
    else this.trouble("no control channel to expire the access token");
  }

  async anotherClientAdds(path: string, text: string): Promise<void> {
    const control = (await this.ensureServing()).control;
    if (control) await this.attempt(`adding ${path} as another client`, () => control.addFile(path, text));
    else this.trouble(`no control channel to add ${path}`);
  }

  async anotherClientTrashes(path: string): Promise<void> {
    const control = (await this.ensureServing()).control;
    if (control) await this.attempt(`trashing ${path} as another client`, () => control.trash(path));
    else this.trouble(`no control channel to trash ${path}`);
  }

  /** Polls the event scheduler the serve asked the Drive for, `times` times. */
  async readEvents(times = 1): Promise<void> {
    const serving = await this.ensureServing();
    const control = serving.control;
    for (let i = 0; i < times; i++) {
      const callsBefore = await this.calls(serving);
      const fired = control ? await this.attempt("polling the event scheduler", () => control.fireEvents()) : undefined;
      if (!control) this.trouble("no control channel to poll the event scheduler");
      this.eventReads.push({ scopes: fired?.scopes, callsBefore, callsAfter: await this.calls(serving) });
    }
  }

  private async calls(serving: Serving): Promise<CallCounts | undefined> {
    return serving.control ? quietly(() => serving.control!.calls()) : undefined;
  }

  /** The control channel of the process that runs the Receive arm now: the mount's, else the serve's. */
  get control(): Control | undefined {
    return this.mount?.control ?? this.serve?.control;
  }

  /**
   * Polls `check` on the control channel until it passes or `ms` pass. Returns undefined when it
   * passed, else why the last check failed.
   */
  async settle(check: (control: Control) => Promise<string | undefined>, ms = SETTLE_MS): Promise<string | undefined> {
    const control = this.control;
    if (!control) return `no process printed a control channel to read the Drive through.\n${this.whatHappened()}`;
    const attempt = async (): Promise<string | undefined> => {
      try {
        return await check(control);
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    // The first check runs on its own, so a bound of 0 still checks once.
    let failure = await attempt();
    if (failure !== undefined && ms > 0) await poll(async () => (failure = await attempt()) === undefined, { withinMs: ms });
    return failure === undefined ? undefined : `${failure}\n${this.whatHappened()}`;
  }

  // --- the mount ------------------------------------------------------------------

  async ensureMounted(): Promise<Serving & { mountpoint: string }> {
    await this.arrange();
    if (!this.mounted) this.trouble("no Given said the user mounts the Drive, yet a step used the mount point");
    if (this.mount?.process.running) return this.mount;
    const mountpoint = await this.prepareMountFolder();
    const dead = this.deadMounts ?? [];
    const port = await freePort();
    const running = this.start(["mount", mountpoint, "--port", String(port), "--state-dir", this.dirs.state, "--fake-drive", this.dirs.drive]);
    const mount: Serving & { mountpoint: string } = { process: running, url: `http://127.0.0.1:${port}/`, mountpoint };
    this.mount = mount;
    if (!(await running.waitFor(() => mountIds(mountpoint).some((id) => !dead.includes(id)), MOUNT_MS))) {
      this.trouble(`nothing was mounted at ${mountpoint} within ${MOUNT_MS / 1000} s: ${running.describe()}`);
    }
    mount.control = Control.fromOutput(running.output);
    await this.setFaults(mount);
    return mount;
  }

  /** Makes the folder the user mounts the Drive at as the Givens arranged it, once, and gives its path. */
  private async prepareMountFolder(): Promise<string> {
    const mountpoint = this.dirs.mountpoint;
    if (this.deadMounts) return mountpoint;
    this.deadMounts = [];
    const folder = this.mountFolder;
    if (folder.kind === "missing") return mountpoint;
    mkdirSync(mountpoint, { recursive: true });
    if (folder.kind === "holds") writeFileSync(join(mountpoint, folder.file), "");
    if (folder.kind === "left mounted") {
      const left = await leaveKilledMount(mountpoint);
      if ("failure" in left) this.trouble(`the folder could not be left mounted by a killed mount: ${left.failure}`);
      else this.deadMounts = left.ids;
    }
    return mountpoint;
  }

  /** Runs `mount` on the arranged folder until it ends on its own, and records what the folder held after. */
  async mountAtFolder(): Promise<void> {
    await this.arrange();
    const mountpoint = await this.prepareMountFolder();
    const port = await freePort();
    const answer = this.runBinary(["mount", mountpoint, "--port", String(port), "--state-dir", this.dirs.state, "--fake-drive", this.dirs.drive]);
    let folderAfter: string[] | undefined;
    try {
      folderAfter = readdirSync(mountpoint);
    } catch (error: unknown) {
      this.trouble(`the folder could not be listed after the mount: ${String(error)}`);
    }
    this.mountRun = { answer, folderAfter };
  }

  async readMountedFile(path: string): Promise<void> {
    const { mountpoint } = await this.ensureMounted();
    const file = await readMounted(join(mountpoint, path));
    const folder = await listMounted(join(mountpoint, parentOf(path)));
    this.mountedRead = { file, folder };
  }

  async writeMountedFile(path: string, text: string): Promise<void> {
    const { mountpoint } = await this.ensureMounted();
    this.mountedWrite = await writeMounted(join(mountpoint, path), new TextEncoder().encode(text));
  }

  // --- the record -----------------------------------------------------------------

  trouble(text: string): void {
    this.troubles.push(text);
  }

  private async attempt<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error: unknown) {
      this.trouble(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** Everything the scenario did, for a Then's failure message. */
  whatHappened(): string {
    const lines: string[] = ["What happened:"];
    if (this.setupSignIn) lines.push(`  signing in: ${this.setupSignIn.describe()}`);
    for (const signIn of this.signIns) lines.push(`  signing in: ${signIn.describe()}`);
    if (this.startedSignIn) lines.push(`  starting to sign in: ${this.startedSignIn.describe()}`);
    if (this.serve) lines.push(`  the serve: ${this.serve.process.describe()}`);
    if (this.secondServe) lines.push(`  the second serve: ${this.secondServe.describe()}`);
    if (this.mount) lines.push(`  the mount: ${this.mount.process.describe()}`);
    if (this.mountRun) lines.push(indent(`mounting: exited ${this.mountRun.answer.exitCode}\n${this.mountRun.answer.stdout}${this.mountRun.answer.stderr}`.trimEnd()));
    if (this.migration) lines.push(indent(`migrating the node keys under ${this.migration.path}: exited ${this.migration.answer.exitCode}\n${this.migration.answer.stdout}${this.migration.answer.stderr}`.trimEnd()));
    for (const action of this.actions) lines.push(indent(`${action.kind} ${action.path}: ${describeOutcome(action.outcome)}`));
    for (const trouble of this.troubles) lines.push(`  trouble: ${trouble}`);
    return lines.join("\n");
  }

  /** Stops every process the scenario started, unmounts, and removes the scenario's directories. */
  async cleanUp(): Promise<void> {
    await Promise.all(this.processes.map((running) => running.stop()));
    if (!this.scratch) return;
    const { root, mountpoint } = this.scratch;
    if (isMounted(mountpoint)) await unmount(mountpoint);
    // Never remove through a mount that is still there.
    if (isMounted(mountpoint)) {
      console.error(`${mountpoint} is still mounted; ${root} is left in place`);
      return;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

setWorldConstructor(DriveWorld);

After(async function (this: DriveWorld) {
  await this.cleanUp();
});

/** Runs `fn`, and gives undefined rather than its error. */
async function quietly<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
