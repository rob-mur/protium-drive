// The DSL layer's World: the one object every step definition reaches the product through.
// Steps speak the project's words and call the Send arm modules under spec/support/send/;
// they never name a command line, a port or a protocol themselves.
//
// The rules the steps keep (rob/continuous-delivery#657):
// - A Given arranges data on this World only: the Drive, the account, the faults, what Proton
//   requires. It starts no process and calls no control channel.
// - A When acts and records what happened, and asserts nothing: it never throws. The first When
//   that needs the product writes the arranged Drive, signs the user in (unless a Given says they
//   have not) and starts the serve on it. A binary that does not start is a recorded outcome.
// - The one Then of a scenario asserts all it claims, positive evidence first. A Then that reads
//   the Drive after a write polls the control channel with a bound; nothing sleeps.
import { answersHttp, freePort, poll } from "@cd-pipeline/support";
import { After, type IWorldOptions, setDefaultTimeout, setWorldConstructor, World } from "@cucumber/cucumber";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DriveSeed, parentOf } from "../support/drive-seed.ts";
import { type Answer, Binary, type Home, indent, type Running } from "../support/send/binary.ts";
import { type CallCounts, Control, type Fault, type Requirements } from "../support/send/control.ts";
import { listeningAddresses, type LocalAnswer, type ProcessView, processTree, rawRequest } from "../support/send/local.ts";
import { isMounted, leaveKilledMount, listMounted, mountIds, type MountOutcome, readMounted, unmount, writeMounted } from "../support/send/mount.ts";
import { describe as describeOutcome, type Outcome, Rclone, refusal } from "../support/send/rclone.ts";
import { propfindWholeTree, type RawAnswer } from "../support/send/webdav.ts";

// A listing of 5000 photos through a cold serve, or a mount, takes a while.
setDefaultTimeout(300_000);

/** How long a process of the binary gets to start, or to end on its own. */
const START_MS = 30_000;
/**
 * How long one sign-in link waits for an approval before it times out: the account module's
 * first 5 s delay, then its 10 minutes of polls (vendor/proton-drive-sdk-account/authWeb.ts).
 */
const SIGN_IN_LINK_LIFETIME_S = 5 + 10 * 60;
/** How long the binary gets to mount the Drive. */
const MOUNT_MS = 60_000;
/** How long a Then waits for the Drive to show a write the serve has answered. */
const SETTLE_MS = 10_000;

/** The mount's option that sets rclone's dir cache time. */
export const DIR_CACHE_TIME_FLAG = "--dir-cache-time";

/** The option that sets how much the binary logs, for pdm and the rclone it runs. */
export const LOG_LEVEL_FLAG = "--log-level";
/** The environment variable that sets the same as LOG_LEVEL_FLAG. */
export const LOG_LEVEL_VARIABLE = "PDM_LOG_LEVEL";

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
  /** The credential a client must send, when the process demands one the World knows. */
  credential?: string;
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

/** One request another program on the machine sent straight to the port. */
export interface LocalRequestRecord {
  /** What the program was, for the failure message. */
  who: string;
  path: string;
  answer: LocalAnswer;
  callsBefore?: CallCounts;
  callsAfter?: CallCounts;
}

/** What a starting mount said it was ready, with whether the folder was mounted when it came. */
export interface Readiness {
  /** The first time the mount's output held a line that says it is mounted at the folder. */
  line?: { mounted: boolean };
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
  /** What Proton's requirement headers say on each Drive call of the serve; none when empty. */
  readonly requirements: Requirements = {};
  refusesNextRefresh = false;
  /** Proton refused the stored session before the scenario's first When. */
  sessionRefused = false;
  root?: string;
  host?: string;
  /** The user reaches the Drive through a mount; the first When at the mount point mounts it. */
  mounted = false;
  /** The folder the user mounts the Drive at, before the mount: an empty folder unless a Given says otherwise. */
  mountFolder: { kind: "empty" } | { kind: "missing" } | { kind: "left mounted" } | { kind: "holds"; file: string } = { kind: "empty" };
  /** The mount's dir cache time, as the user writes it; unset, the mount's default. */
  dirCacheTime?: string;
  /** The log level the user gives the serve or the mount with LOG_LEVEL_FLAG; unset, none. */
  logLevel?: string;
  /** The value of LOG_LEVEL_VARIABLE in the environment the user starts the mount in; unset, none. */
  logLevelVariable?: string;
  /**
   * The file the user keeps the serve's credential in, with its mode; unset, the serve has no
   * credential file. The user's own client sends the credential.
   */
  credentialFile?: { mode: number };
  /** The serve's credential, as the file holds it. */
  readonly credential = randomBytes(32).toString("hex");
  /** The user starts the serve with `--no-credential`. */
  noCredential = false;
  /** The user cannot write to the serve's state folder once they have signed in. */
  stateReadOnly = false;
  /**
   * The credential a serve without a credential file made in its state folder, as the user read
   * it the first time; a restarted serve must take the same one.
   */
  madeCredential?: string;

  // --- what the Whens record --------------------------------------------------
  /** The UID of each node the arranged Drive held, by path. */
  uids = new Map<string, string>();
  /** The sign-in the arrangement made, for a scenario where the user has signed in. */
  setupSignIn?: Running;
  /** The sign-ins a When made, last last. */
  readonly signIns: Running[] = [];
  /** A sign-in a When started and stopped once it printed its URL. */
  startedSignIn?: Running;
  /** A sign-in a When started and let end on its own, or stopped after START_MS. */
  signInAttempt?: Running;
  /** Whether that sign-in ended on its own within START_MS. */
  signInAttemptEnded?: boolean;
  /** The serve the arrangement ran to have Proton refuse the stored session. */
  private refusingServe?: Running;
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
  readonly localRequests: LocalRequestRecord[] = [];
  /** The mount's processes, as another program read them from the process table. */
  mountProcesses?: ProcessView[];
  /** The addresses the serve's port listened on, as another program read them. */
  serveListensOn?: string[];
  mountedListings: { path: string; outcome: MountOutcome }[] = [];
  /** What the mount said while it started, from its start until it said it was ready. */
  readonly readiness: Readiness = {};
  /** The mounts that ended before the one in `mount` started, oldest first. */
  endedMounts: (Serving & { mountpoint: string })[] = [];
  /** Whether the folder was mounted just before a When stopped the mount. */
  mountedBeforeStop?: boolean;
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
      return { exitCode: -1, stdout: "", stderr: `'protium-drive ${args.join(" ")}' did not run: ${String(error)}` };
    }
  }

  private start(args: string[], variables: Record<string, string> = {}): Running {
    const running = this.binary.start(args, this.dirs.home, variables);
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

  /**
   * `auth login`, through `timeouts` sign-in links that time out on the Receive arm's clock while
   * no one approves them. With `approve`, the user then approves the next link; without, the
   * sign-in gets START_MS to end on its own.
   */
  async signInThroughTimeouts(timeouts: number, approve: boolean): Promise<void> {
    await this.arrange();
    const running = this.start(this.signInArgs());
    this.signIns.push(running);
    await running.waitFor((p) => Control.fromOutput(p.output) !== undefined, START_MS);
    const control = Control.fromOutput(running.output);
    if (!control) {
      this.trouble(`signing in printed no control channel: ${running.describe()}`);
      if (running.running) await running.stop();
      return;
    }
    const linkWaits = async (link: number) => {
      const waits = await running.waitFor(async () => {
        const signIns = (await quietly(() => control.account()))?.signIns;
        return !!signIns && signIns.started >= link && signIns.pending >= 1;
      }, START_MS);
      if (!waits) this.trouble(`sign-in link ${link} did not wait for an approval: ${running.describe()}`);
      return waits;
    };
    for (let link = 1; link <= timeouts; link++) {
      if (!(await linkWaits(link))) break;
      await this.attempt(`letting sign-in link ${link} time out`, () => control.advanceClock(SIGN_IN_LINK_LIFETIME_S));
    }
    if (approve && running.running && (await linkWaits(timeouts + 1))) {
      await this.attempt(`approving sign-in link ${timeouts + 1}`, () => control.approveSignIn());
    }
    if (!(await running.waitForEnd(START_MS))) {
      this.trouble(`signing in did not end within ${START_MS / 1000} s`);
      await running.stop();
    }
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

  /** Starts `auth login` and gives it START_MS to end on its own; no one approves it. */
  async trySigningIn(): Promise<void> {
    await this.arrange();
    const running = this.start(this.signInArgs());
    this.signInAttempt = running;
    this.signInAttemptEnded = await running.waitForEnd(START_MS);
    if (!this.signInAttemptEnded) await running.stop();
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
    if (this.credentialFile) {
      try {
        writeFileSync(this.credentialPath(), `${this.credential}\n`);
        chmodSync(this.credentialPath(), this.credentialFile.mode);
      } catch (error: unknown) {
        this.trouble(`the credential file could not be written: ${String(error)}`);
      }
    }
    if (this.signedIn) this.setupSignIn = await this.signIn();
    if (this.sessionRefused) await this.refuseTheSession();
    if (this.stateReadOnly) {
      try {
        mkdirSync(this.dirs.state, { recursive: true, mode: 0o700 });
        chmodSync(this.dirs.state, 0o500);
      } catch (error: unknown) {
        this.trouble(`the state folder could not be made read-only: ${String(error)}`);
      }
    }
  }

  /** Where a serve without a credential file keeps the credential it makes. */
  madeCredentialPath(): string {
    return join(this.dirs.state, "serve-credential");
  }

  /**
   * The credential the user's client sends to a serve: the one in the user's own file, else the
   * one the serve made in its state folder (read once, the first time it is there), else none.
   */
  private serveCredential(): string | undefined {
    if (this.credentialFile) return this.credential;
    if (this.madeCredential === undefined && existsSync(this.madeCredentialPath())) {
      this.madeCredential = readFileSync(this.madeCredentialPath(), "utf8").trim();
    }
    return this.madeCredential;
  }

  private credentialPath(): string {
    return join(this.dirs.root, "credential");
  }

  /**
   * Has Proton refuse the stored session: a serve whose account refuses the next refresh, an
   * expired access token and one listing, then the serve stops.
   */
  private async refuseTheSession(): Promise<void> {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const running = this.start(this.serveArgs(port));
    this.refusingServe = running;
    if (!(await running.waitFor(() => answersHttp(url), START_MS))) {
      this.trouble(`the serve that was to have the session refused did not answer on ${url}: ${running.describe()}`);
    }
    const control = Control.fromOutput(running.output);
    if (control) {
      await this.attempt("making the account refuse the next refresh", () => control.refuseNextRefresh());
      await this.attempt("expiring the access token", () => control.expireAccessToken());
      await new Rclone(url, undefined, this.serveCredential()).list("");
    } else this.trouble("the serve that was to have the session refused printed no control channel");
    await running.stop();
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
      ...(this.credentialFile ? ["--credential-file", this.credentialPath()] : []),
      ...(this.noCredential ? ["--no-credential"] : []),
      ...this.logLevelArgs(),
    ];
  }

  /** The user's WebDAV client of `serving`: it sends the credential the serve demands. */
  private client(serving: Serving): Rclone {
    return new Rclone(serving.url, undefined, serving.credential);
  }

  private logLevelArgs(): string[] {
    return this.logLevel === undefined ? [] : [LOG_LEVEL_FLAG, this.logLevel];
  }

  /** The process that serves the arranged Drive: the mount when a Given said the user mounts it, else the serve. */
  private serving(): Promise<Serving> {
    return this.mounted ? this.ensureMounted() : this.ensureServing();
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
    serve.credential = this.serveCredential();
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

  /** The arranged faults, the refused refresh and the requirements, set once, on the first process with a Receive arm. */
  private async setFaults(serving: Serving): Promise<void> {
    const requires = Object.keys(this.requirements).length > 0;
    if (this.faultsSet || (this.faults.length === 0 && !this.refusesNextRefresh && !requires)) return;
    this.faultsSet = true;
    const control = serving.control;
    if (!control) {
      this.trouble("the binary printed no control channel, so the arranged faults were never set");
      return;
    }
    for (const fault of this.faults) await this.attempt(`setting the fault ${JSON.stringify(fault)}`, () => control.addFault(fault));
    if (this.refusesNextRefresh) await this.attempt("making the account refuse the next refresh", () => control.refuseNextRefresh());
    if (requires) await this.attempt(`setting the requirements ${JSON.stringify(this.requirements)}`, () => control.setRequirements(this.requirements));
  }

  // --- a WebDAV client ------------------------------------------------------------

  private async act(kind: ActionKind, path: string, run: (client: Rclone) => Promise<Outcome>): Promise<Action> {
    const serving = await this.ensureServing();
    const callsBefore = await this.calls(serving);
    const outcome = await run(this.client(serving));
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

  /**
   * Writes `text` to `path` while the Receive arm's clock moves on by `seconds`: it starts the
   * write, waits until the Drive's upload has started, moves the clock, then gives the write
   * SETTLE_MS to end. A write that does not end in that time is recorded as one that did not end.
   */
  async writeWhileTimePasses(path: string, text: string, seconds: number): Promise<void> {
    const serving = await this.ensureServing();
    const callsBefore = await this.calls(serving);
    const started = (calls?: CallCounts) => calls?.methods.uploadFromStream ?? 0;
    const writing = this.client(serving).write(path, new TextEncoder().encode(text));
    let ended = false;
    void writing.then(() => (ended = true));
    const uploading = await poll(async () => ended || started(await this.calls(serving)) > started(callsBefore), { withinMs: START_MS }).then(
      () => true,
      () => false,
    );
    if (!uploading) this.trouble(`the upload of ${path} did not start in ${START_MS / 1000} s`);
    await this.pass(seconds);
    const unended: Outcome = { command: `writing ${path}`, exitCode: -1, stdout: new Uint8Array(), stderr: `the write did not end ${SETTLE_MS / 1000} s after the clock moved`, exchanges: [], timedOut: true };
    const outcome = await Promise.race([writing, new Promise<Outcome>((resolve) => setTimeout(() => resolve(unended), SETTLE_MS))]);
    this.actions.push({ kind: "write", path, outcome, callsBefore, callsAfter: await this.calls(serving) });
  }

  /**
   * Writes `waitingText` to `waitingPath` and waits until the serve has asked the Drive for its
   * uploader; then writes `text` to `path` and waits until that upload has started. It moves the
   * Drive's clock on by `seconds`, then gives both writes SETTLE_MS to end, and records them in
   * that order.
   */
  async writeBehindWhileTimePasses(waitingPath: string, waitingText: string, path: string, text: string, seconds: number): Promise<void> {
    const serving = await this.ensureServing();
    const callsBefore = await this.calls(serving);
    const count = (method: string) => (calls?: CallCounts) => calls?.methods[method] ?? 0;
    const start = async (target: string, content: string, method: string, what: string) => {
      const before = await this.calls(serving);
      const writing = this.client(serving).write(target, new TextEncoder().encode(content));
      let ended = false;
      void writing.then(() => (ended = true));
      const reached = await poll(async () => ended || count(method)(await this.calls(serving)) > count(method)(before), { withinMs: START_MS }).then(
        () => true,
        () => false,
      );
      if (!reached) this.trouble(`the upload of ${target} did not ${what} in ${START_MS / 1000} s`);
      return { writing };
    };
    const { writing: waiting } = await start(waitingPath, waitingText, "getFileUploader", "ask for an uploader");
    const { writing } = await start(path, text, "uploadFromStream", "start");
    await this.pass(seconds);
    const ending = (target: string, write: Promise<Outcome>) => {
      const unended: Outcome = { command: `writing ${target}`, exitCode: -1, stdout: new Uint8Array(), stderr: `the write did not end ${SETTLE_MS / 1000} s after the clock moved`, exchanges: [], timedOut: true };
      return Promise.race([write, new Promise<Outcome>((resolve) => setTimeout(() => resolve(unended), SETTLE_MS))]);
    };
    const [waitingOutcome, outcome] = await Promise.all([ending(waitingPath, waiting), ending(path, writing)]);
    const callsAfter = await this.calls(serving);
    this.actions.push({ kind: "write", path: waitingPath, outcome: waitingOutcome, callsBefore, callsAfter });
    this.actions.push({ kind: "write", path, outcome, callsBefore, callsAfter });
  }

  /**
   * Writes `text` to `path`, waits until the serve has asked the Drive for an uploader, lets
   * `seconds` pass on the Drive's clock, then waits for the write to end.
   */
  async writeWhileWaitingToStart(path: string, text: string, seconds: number): Promise<void> {
    const serving = await this.ensureServing();
    const callsBefore = await this.calls(serving);
    const asked = (calls?: CallCounts) => calls?.methods.getFileUploader ?? 0;
    const writing = this.client(serving).write(path, new TextEncoder().encode(text));
    let ended = false;
    void writing.then(() => (ended = true));
    const waiting = await poll(async () => ended || asked(await this.calls(serving)) > asked(callsBefore), { withinMs: START_MS }).then(
      () => true,
      () => false,
    );
    if (!waiting) this.trouble(`the upload of ${path} did not ask for an uploader in ${START_MS / 1000} s`);
    await this.pass(seconds);
    const unended: Outcome = { command: `writing ${path}`, exitCode: -1, stdout: new Uint8Array(), stderr: `the write did not end ${SETTLE_MS / 1000} s after the clock moved`, exchanges: [], timedOut: true };
    const outcome = await Promise.race([writing, new Promise<Outcome>((resolve) => setTimeout(() => resolve(unended), SETTLE_MS))]);
    this.actions.push({ kind: "write", path, outcome, callsBefore, callsAfter: await this.calls(serving) });
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
    const answer = await propfindWholeTree(serving.url, path, serving.credential);
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
    const control = (await this.serving()).control;
    if (control) await this.attempt(`adding ${path} as another client`, () => control.addFile(path, text));
    else this.trouble(`no control channel to add ${path}`);
  }

  /**
   * Uploads a new revision of the file at `path`, as another device that edits it does: its upload
   * claims the time of the edit, which falls in a later second than the time the file had.
   */
  async anotherClientReplaces(path: string, text: string): Promise<void> {
    const control = (await this.serving()).control;
    if (!control) return this.trouble(`no control channel to replace ${path}`);
    await this.attempt(`replacing ${path} as another client`, async () => {
      const node = await control.node(path);
      if (node.type !== "file") throw new Error(`${path} is a ${node.type}, not a file`);
      const before = Date.parse(node.claimedModificationTime ?? node.modified);
      return control.addFile(path, text, new Date(Math.max(Date.now(), before + 1000)));
    });
  }

  async anotherClientTrashes(path: string): Promise<void> {
    const control = (await this.ensureServing()).control;
    if (control) await this.attempt(`trashing ${path} as another client`, () => control.trash(path));
    else this.trouble(`no control channel to trash ${path}`);
  }

  /** Polls the event scheduler the serve asked the Drive for, `times` times. */
  async readEvents(times = 1): Promise<void> {
    const serving = await this.serving();
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

  async ensureMounted(port?: number): Promise<Serving & { mountpoint: string }> {
    await this.arrange();
    if (!this.mounted) this.trouble("no Given said the user mounts the Drive, yet a step used the mount point");
    if (this.mount?.process.running) return this.mount;
    const mountpoint = await this.prepareMountFolder();
    const dead = this.deadMounts ?? [];
    port ??= await freePort();
    const running = this.start([
      "mount",
      mountpoint,
      "--port",
      String(port),
      "--state-dir",
      this.dirs.state,
      "--fake-drive",
      this.dirs.drive,
      ...(this.dirCacheTime === undefined ? [] : [DIR_CACHE_TIME_FLAG, this.dirCacheTime]),
      ...this.logLevelArgs(),
    ], this.logLevelVariable === undefined ? {} : { [LOG_LEVEL_VARIABLE]: this.logLevelVariable });
    const mount: Serving & { mountpoint: string } = { process: running, url: `http://127.0.0.1:${port}/`, mountpoint };
    if (this.mount) this.endedMounts.push(this.mount);
    this.mount = mount;
    const mounted = () => mountIds(mountpoint).some((id) => !dead.includes(id));
    if (!(await running.waitFor(() => this.watchReadiness(mount, mounted()), MOUNT_MS))) {
      this.trouble(`nothing was mounted at ${mountpoint} within ${MOUNT_MS / 1000} s: ${running.describe()}`);
    }
    mount.control = Control.fromOutput(running.output);
    await this.setFaults(mount);
    return mount;
  }

  /**
   * Notes the first line the starting mount printed that says it is mounted at the folder, with
   * whether the folder is mounted now. Gives `mounted` back, so it can be a waitFor's check.
   */
  private watchReadiness(mount: Serving & { mountpoint: string }, mounted: boolean): boolean {
    if (!this.readiness.line && mountedLines(mount.process.output, mount.mountpoint).length > 0) this.readiness.line = { mounted };
    return mounted;
  }

  /**
   * Starts the mount and waits until it says it is ready: a line that says it is mounted at the
   * folder.
   */
  async startMount(): Promise<void> {
    const mount = await this.ensureMounted();
    const dead = this.deadMounts ?? [];
    const said = () => this.readiness.line !== undefined;
    const ready = await mount.process.waitFor(
      () => (this.watchReadiness(mount, mountIds(mount.mountpoint).some((id) => !dead.includes(id))), said()),
      MOUNT_MS,
    );
    if (!ready) this.trouble(`the mount did not say it was ready within ${MOUNT_MS / 1000} s: ${mount.process.describe()}`);
  }

  /**
   * Kills the mount and every process it started with SIGKILL, as a service manager kills a
   * service's processes, so nothing unmounts and nothing flushes.
   */
  async killMountAndItsProcesses(): Promise<void> {
    const mount = this.mount;
    const pid = mount?.process.pid;
    if (!mount || pid === undefined) {
      this.trouble("there was no running mount to kill");
      return;
    }
    for (const { pid: each } of processTree(pid).reverse()) {
      try {
        process.kill(each, "SIGKILL");
      } catch {
        // It ended on its own already.
      }
    }
    await mount.process.ended;
    // The killed mount stays in the mount table. Clearing it here keeps the next start's wait
    // simple: Linux reuses mount ids, so a new mount can carry the dead one's id.
    const cleared = await unmount(mount.mountpoint);
    if (cleared.exitCode !== 0) this.trouble(`the killed mount could not be cleared (${cleared.command}): ${cleared.stderr}`);
  }

  /** Starts the mount again after it ended: on the port the last one had, or on another free one. */
  async mountAgain(port: "same" | "another"): Promise<void> {
    const last = this.mount;
    if (!last || last.process.running) {
      this.trouble("there was no ended mount to start again");
      return;
    }
    const lastPort = Number(new URL(last.url).port);
    let next = lastPort;
    if (port === "another") while (next === lastPort) next = await freePort();
    await this.ensureMounted(next);
  }

  /** Stops the mount as a service manager stops it (SIGTERM), and waits for it to end. */
  async stopMount(): Promise<void> {
    const mount = this.mount;
    if (!mount) {
      this.trouble("there was no mount to stop");
      return;
    }
    this.mountedBeforeStop = isMounted(mount.mountpoint);
    await mount.process.stop();
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

  async listMountedFolder(path: string): Promise<void> {
    const { mountpoint } = await this.ensureMounted();
    this.mountedListings.push({ path, outcome: await listMounted(join(mountpoint, path)) });
  }

  async writeMountedFile(path: string, text: string): Promise<void> {
    const { mountpoint } = await this.ensureMounted();
    this.mountedWrite = await writeMounted(join(mountpoint, path), new TextEncoder().encode(text));
  }

  // --- other programs on the same machine -------------------------------------------

  /** A web page that reached the serve's port under a name of its own, by DNS rebinding. */
  async listAsForeignSite(path: string): Promise<void> {
    const serving = await this.ensureServing();
    await this.sendLocal(serving, "a web page at evil.example", path, `evil.example:${new URL(serving.url).port}`);
  }

  /** A program that lists `path` at the mount's port without the mount's credential. */
  async listAtMountWithoutCredential(path: string): Promise<void> {
    const mount = await this.ensureMounted();
    await this.sendLocal(mount, "a program without the mount's credential", path, new URL(mount.url).host);
  }

  /** A program that lists `path` at the serve's port without the serve's credential. */
  async listAtServeWithoutCredential(path: string): Promise<void> {
    const serving = await this.ensureServing();
    await this.sendLocal(serving, "a program without the serve's credential", path, new URL(serving.url).host);
  }

  /** A program that lists `path` at the serve's port with a credential that is not the serve's. */
  async listAtServeWithWrongCredential(path: string): Promise<void> {
    const serving = await this.ensureServing();
    const wrong = `Bearer ${randomBytes(32).toString("hex")}`;
    await this.sendLocal(serving, "a program with a wrong credential", path, new URL(serving.url).host, wrong);
  }

  private async sendLocal(serving: Serving, who: string, path: string, host: string, authorization?: string): Promise<void> {
    const callsBefore = await this.calls(serving);
    const answer = await rawRequest(serving.url, { method: "PROPFIND", path, host, authorization });
    this.localRequests.push({ who, path, answer, callsBefore, callsAfter: await this.calls(serving) });
  }

  /** A program that reads the mount's processes from the process table, as `ps` does. */
  async readMountProcesses(): Promise<void> {
    const mount = await this.ensureMounted();
    const pid = mount.process.pid;
    if (pid === undefined) {
      this.trouble("the mount has no process id to read");
      return;
    }
    this.mountProcesses = processTree(pid);
  }

  /** A program that reads which addresses the serve's port listens on, as `ss -ltn` does. */
  async readServeListeningAddresses(): Promise<void> {
    const serve = await this.ensureServing();
    this.serveListensOn = listeningAddresses(Number(new URL(serve.url).port));
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
    if (this.refusingServe) lines.push(`  the serve that had the session refused: ${this.refusingServe.describe()}`);
    if (this.signInAttempt) lines.push(`  trying to sign in: ${this.signInAttempt.describe()}`);
    if (this.startedSignIn) lines.push(`  starting to sign in: ${this.startedSignIn.describe()}`);
    if (this.serve) lines.push(`  the serve: ${this.serve.process.describe()}`);
    if (this.secondServe) lines.push(`  the second serve: ${this.secondServe.describe()}`);
    for (const ended of this.endedMounts) lines.push(`  an earlier mount: ${ended.process.describe()}`);
    if (this.mount) lines.push(`  the mount: ${this.mount.process.describe()}`);
    if (this.mountRun) lines.push(indent(`mounting: exited ${this.mountRun.answer.exitCode}\n${this.mountRun.answer.stdout}${this.mountRun.answer.stderr}`.trimEnd()));
    for (const { path, outcome } of this.mountedListings) lines.push(indent(`listing the mounted folder ${path} (${outcome.command}): exited ${outcome.exitCode}\n${new TextDecoder().decode(outcome.stdout)}${outcome.stderr}`.trimEnd()));
    if (this.migration) lines.push(indent(`migrating the node keys under ${this.migration.path}: exited ${this.migration.answer.exitCode}\n${this.migration.answer.stdout}${this.migration.answer.stderr}`.trimEnd()));
    for (const action of this.actions) lines.push(indent(`${action.kind} ${action.path}: ${describeOutcome(action.outcome)}`));
    if (this.serveListensOn) lines.push(`  the serve's port listened on: ${this.serveListensOn.join(", ") || "nothing"}`);
    for (const request of this.localRequests) lines.push(indent(`${request.who} listed ${request.path}:\n${request.answer.text}`.trimEnd()));
    for (const trouble of this.troubles) lines.push(`  trouble: ${trouble}`);
    return lines.join("\n");
  }

  /** Stops every process the scenario started, unmounts, and removes the scenario's directories. */
  async cleanUp(): Promise<void> {
    await Promise.all(this.processes.map((running) => running.stop()));
    if (!this.scratch) return;
    const { root, mountpoint } = this.scratch;
    if (this.stateReadOnly && existsSync(this.dirs.state)) chmodSync(this.dirs.state, 0o700);
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

/** The lines of `output` that say the mount is mounted at `mountpoint`, in any case. */
export function mountedLines(output: string, mountpoint: string): string[] {
  const said = `mounted at ${mountpoint}`.toLowerCase();
  return output.split("\n").filter((line) => line.toLowerCase().includes(said));
}
