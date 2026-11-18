// The Send arm as another program on the same machine: a web page that reached the port under a
// name of its own (DNS rebinding), a program that talks to the port without the mount's
// credential, and a program that reads the process table. None of them is a WebDAV client the
// user chose, so none goes through rclone.
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";

/** What the serve answered a raw request with. */
export interface LocalAnswer {
  /** Undefined when the serve did not answer. */
  status?: number;
  /** The whole answer as it came off the socket, or why none came. */
  text: string;
}

export interface LocalRequest {
  method: string;
  /** The folder to ask about, under the serve's root. */
  path: string;
  /** The Host header to send, `host:port`. */
  host: string;
  /** The Authorization header to send; unset, none. */
  authorization?: string;
}

/**
 * Sends one HTTP/1.1 request to the serve at `url` over a plain socket, so nothing but this
 * function chooses its headers: the Host header given, and Authorization only when given.
 */
export function rawRequest(url: string, request: LocalRequest): Promise<LocalAnswer> {
  const target = new URL(url);
  const path = `/${request.path.split("/").map(encodeURIComponent).join("/")}/`;
  const authorization = request.authorization === undefined ? [] : [`Authorization: ${request.authorization}`];
  const head = [`${request.method} ${path} HTTP/1.1`, `Host: ${request.host}`, ...authorization, "Depth: 1", "Content-Length: 0", "Connection: close", "", ""].join("\r\n");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: target.hostname, port: Number(target.port) });
    const done = (error?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      const text = Buffer.concat(chunks).toString("utf8");
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1];
      resolve({ status: status ? Number(status) : undefined, text: error && !status ? `${text}${String(error)}` : text });
    };
    const timer = setTimeout(() => done(new Error("no answer within 30 s")), 30_000);
    socket.on("connect", () => socket.write(head));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => done());
    socket.on("error", (error) => done(error));
  });
}

/** One process, as `ps` and `/proc` show it to a program of the same user. */
export interface ProcessView {
  pid: number;
  /** The command line, one argument per entry. */
  argv: string[];
  /** The environment, by name; empty when it could not be read. */
  env: Record<string, string>;
}

/** The process `pid` and every process under it. */
export function processTree(pid: number): ProcessView[] {
  const parents = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = quietRead(`/proc/${entry}/stat`);
    // Field 4 is the parent; field 2, the name, is in brackets and may hold spaces.
    const parent = stat ? Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) : NaN;
    if (Number.isFinite(parent)) parents.set(Number(entry), parent);
  }
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) {
    for (const [child, parent] of parents) if (parent === tree[i] && !tree.includes(child)) tree.push(child);
  }
  return tree.map((each) => ({ pid: each, argv: nulSeparated(quietRead(`/proc/${each}/cmdline`)), env: environment(quietRead(`/proc/${each}/environ`)) }));
}

function nulSeparated(text: string | undefined): string[] {
  return (text ?? "").split("\0").filter((part) => part !== "");
}

function environment(text: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of nulSeparated(text)) {
    const at = pair.indexOf("=");
    if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return env;
}

function quietRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The addresses on which a TCP socket listens on `port`, as a program reads them from
 * `/proc/net/tcp` and `/proc/net/tcp6`, such as `127.0.0.1`, `0.0.0.0` or `::`.
 */
export function listeningAddresses(port: number): string[] {
  const addresses: string[] = [];
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (quietRead(table) ?? "").split("\n").slice(1)) {
      // Field 1 is the local address as hex `address:port`; field 3 is the state, 0A for LISTEN.
      const fields = line.trim().split(/\s+/);
      const [address, hexPort] = (fields[1] ?? "").split(":");
      if (fields[3] !== "0A" || !address || parseInt(hexPort ?? "", 16) !== port) continue;
      addresses.push(address.length === 8 ? ipv4(address) : ipv6(address));
    }
  }
  return addresses;
}

/** An IPv4 address as `/proc/net/tcp` writes it: four bytes in hex, in the machine's order. */
function ipv4(hex: string): string {
  return Buffer.from(hex, "hex").readUInt32LE(0).toString(16).padStart(8, "0").match(/../g)!.map((byte) => parseInt(byte, 16)).join(".");
}

/** An IPv6 address as `/proc/net/tcp6` writes it: four 32-bit words in hex, each in the machine's order. */
function ipv6(hex: string): string {
  const bytes = Buffer.alloc(16);
  for (let word = 0; word < 4; word++) bytes.writeUInt32BE(Buffer.from(hex.slice(word * 8, word * 8 + 8), "hex").readUInt32LE(0), word * 4);
  const groups = bytes.toString("hex").match(/..../g)!.map((group) => parseInt(group, 16).toString(16));
  return groups.join(":").replace(/(^|:)0(:0)+(:|$)/, "::");
}
