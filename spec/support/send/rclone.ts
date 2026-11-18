// The Send arm's WebDAV half: stock rclone, as a `:webdav:` remote with `vendor = other`, the
// client the mount runs and the one a user points at the serve. Each action is one rclone
// command; it tries each request once (`--low-level-retries 1 --retries 1`), so a refusal reaches
// the step as the serve gave it, and it dumps the headers of every exchange, so a step reads the
// statuses and `Retry-After` the serve answered. No step names rclone: steps call the actions here.
import { spawn } from "node:child_process";

/** One HTTP exchange of an rclone command, as `--dump headers` shows it. */
export interface Exchange {
  method: string;
  /** The request path, as sent. */
  path: string;
  /** Undefined when no response came. */
  status?: number;
  /** The response headers, names in lower case. */
  headers: Record<string, string>;
}

/** What one rclone command did. */
export interface Outcome {
  /** The command line, for a failure message. */
  command: string;
  /** -1 when it did not end on its own (see `timedOut`) or could not start. */
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
  exchanges: Exchange[];
  timedOut: boolean;
}

/** One entry of a listing (`rclone lsjson`). */
export interface Entry {
  Path: string;
  Name: string;
  Size: number;
  MimeType?: string;
  ModTime?: string;
  IsDir: boolean;
}

const COMMAND_TIMEOUT_MS = 120_000;

export class Rclone {
  /**
   * `url`: the serve, as `http://127.0.0.1:<port>/`. `bearerToken`: the serve's credential, which
   * the client sends as rclone's webdav `bearer_token`; unset, it sends none.
   */
  constructor(
    readonly url: string,
    private readonly executable = process.env.PDM_RCLONE || "rclone",
    private readonly bearerToken?: string,
  ) {}

  /** The entries of the folder `path` ("" is the root). */
  list(path: string): Promise<Outcome> {
    return this.run(["lsjson", this.remote(path)]);
  }

  /** The entry at `path` itself. */
  stat(path: string): Promise<Outcome> {
    return this.run(["lsjson", "--stat", this.remote(path)]);
  }

  /** The content of the file `path`, or `count` bytes of it from byte `offset`. */
  read(path: string, range?: { offset: number; count: number }): Promise<Outcome> {
    const part = range ? ["--offset", String(range.offset), "--count", String(range.count)] : [];
    return this.run(["cat", ...part, this.remote(path)]);
  }

  /** Writes `content` to the file `path`, from standard input as a client streams it. */
  write(path: string, content: Uint8Array): Promise<Outcome> {
    return this.run(["rcat", this.remote(path)], content);
  }

  deleteFile(path: string): Promise<Outcome> {
    return this.run(["deletefile", this.remote(path)]);
  }

  makeFolder(path: string): Promise<Outcome> {
    return this.run(["mkdir", this.remote(path)]);
  }

  removeFolder(path: string): Promise<Outcome> {
    return this.run(["rmdir", this.remote(path)]);
  }

  /** Moves or renames the file or folder `from` to `to`. */
  move(from: string, to: string): Promise<Outcome> {
    return this.run(["moveto", this.remote(from), this.remote(to)]);
  }

  private remote(path: string): string {
    const token = this.bearerToken === undefined ? "" : `,bearer_token="${this.bearerToken}"`;
    return `:webdav,url="${this.url}",vendor=other${token}:${path}`;
  }

  private run(args: string[], stdin?: Uint8Array): Promise<Outcome> {
    const full = [...args, "--low-level-retries", "1", "--retries", "1", "--dump", "headers"];
    const command = `rclone ${full.join(" ")}`;
    return new Promise((resolve) => {
      const child = spawn(this.executable, full, {
        // No config file: the remote is all in the remote string.
        env: { ...process.env, RCLONE_CONFIG: "/nonexistent/rclone.conf" },
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, COMMAND_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => (stderr += chunk));
      if (stdin && child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(stdin);
      }
      const finish = (exitCode: number) => {
        clearTimeout(timer);
        resolve({ command, exitCode, stdout: new Uint8Array(Buffer.concat(stdout)), stderr, exchanges: exchanges(stderr), timedOut });
      };
      child.on("error", (error) => {
        stderr += `\n${command} could not start: ${error.message}`;
        finish(-1);
      });
      child.on("close", (code) => finish(timedOut ? -1 : (code ?? -1)));
    });
  }
}

/** The entries an `lsjson` printed, or undefined when it printed no JSON array. */
export function entries(outcome: Outcome): Entry[] | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(outcome.stdout));
    return Array.isArray(parsed) ? (parsed as Entry[]) : undefined;
  } catch {
    return undefined;
  }
}

/** The entry an `lsjson --stat` printed. */
export function entry(outcome: Outcome): Entry | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(outcome.stdout));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Entry) : undefined;
  } catch {
    return undefined;
  }
}

/** The last exchange of `method` the server refused, with a status of 400 or more. */
export function refusal(outcome: Outcome, method: string): Exchange | undefined {
  return outcome.exchanges.filter((exchange) => exchange.method === method && (exchange.status ?? 0) >= 400).at(-1);
}

/** What the command did, for a failure message. */
export function describe(outcome: Outcome): string {
  const ended = outcome.timedOut ? `did not end in ${COMMAND_TIMEOUT_MS / 1000} s` : `exited ${outcome.exitCode}`;
  const seen = outcome.exchanges.length
    ? outcome.exchanges.map((e) => `${e.method} ${e.path} -> ${e.status ?? "no response"}${e.headers["retry-after"] ? ` (Retry-After: ${e.headers["retry-after"]})` : ""}`)
    : ["no HTTP exchange"];
  const errors = outcome.stderr
    .split("\n")
    .filter((line) => / (ERROR|NOTICE|CRITICAL) ?: /.test(line) || line.includes("could not start"))
    .slice(-5);
  return [`'${outcome.command}' ${ended}`, ...seen.map((s) => `  ${s}`), ...errors.map((s) => `  ${s}`)].join("\n");
}

const LOG_LINE = /^\S+ \S+ DEBUG : (.*)$/;

/**
 * The exchanges in `--dump headers` output. Each request and each response is one log entry: a
 * marker line naming the request (`HTTP REQUEST (req 0x…)`), its request or status line, then its
 * headers up to a blank line. The dumped request and response use CRLF line ends.
 */
export function exchanges(stderr: string): Exchange[] {
  const lines = stderr.split(/\r?\n/);
  const byRequest = new Map<string, Exchange>();
  const ordered: Exchange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const marker = LOG_LINE.exec(lines[i]!)?.[1]?.match(/^HTTP (REQUEST|RESPONSE) \(req (0x[0-9a-f]+)\)$/);
    if (!marker) continue;
    const [, kind, id] = marker;
    const first = LOG_LINE.exec(lines[i + 1] ?? "")?.[1] ?? "";
    const headers: Record<string, string> = {};
    let j = i + 2;
    for (; j < lines.length && lines[j] !== ""; j++) {
      const header = /^([A-Za-z0-9-]+): ?(.*)$/.exec(lines[j]!);
      if (header) headers[header[1]!.toLowerCase()] = header[2]!;
    }
    i = j;
    if (kind === "REQUEST") {
      const request = /^([A-Z]+) (\S+) HTTP\/[\d.]+$/.exec(first);
      if (!request) continue;
      const exchange: Exchange = { method: request[1]!, path: decodePath(request[2]!), headers: {} };
      byRequest.set(id!, exchange);
      ordered.push(exchange);
    } else {
      const exchange = byRequest.get(id!);
      const status = /^HTTP\/[\d.]+ (\d{3})/.exec(first);
      if (!exchange || !status) continue;
      exchange.status = Number(status[1]);
      exchange.headers = headers;
    }
  }
  return ordered;
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
