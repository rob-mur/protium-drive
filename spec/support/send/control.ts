// The client of the Receive arm's control channel (fake-drive/control.ts): HTTP and JSON on
// 127.0.0.1. The binary started with `--fake-drive DIR` prints the channel's URL, and the steps
// read the Drive and change it through this module, as another client of the Drive would.
// It mirrors the channel's routes and types rather than importing them, so the suite needs none
// of the product's dependencies.

/** The line the Receive arm prints (fake-drive/receive-arm.ts, `CONTROL_LINE`); group 1 is the URL. */
export const CONTROL_LINE = /^fake-drive: control channel at (http:\/\/127\.0\.0\.1:\d+\/)$/m;

/** The node at a path (`NodeInfo` in fake-drive/drive.ts). */
export interface NodeInfo {
  uid: string;
  parentUid?: string;
  name: string;
  type: "file" | "folder";
  created: string;
  modified: string;
  trashed?: string;
  claimedModificationTime?: string;
  nameUndecryptable?: boolean;
  clearTextSize?: boolean;
  path: string;
  mediaType?: string;
  revisionCount: number;
  /** The OpenPGP version of a file's node key (4 or 6). */
  nodeKeyVersion?: number;
}

/** One revision of a file (`RevisionInfo` in fake-drive/drive.ts). */
export interface RevisionInfo {
  uid: string;
  created: string;
  size: number;
  declaredSize: number | null;
  mediaType: string;
  claimedModificationTime?: string;
  state: "active" | "superseded";
}

/** The SDK calls the binary made (`CallCounts` in fake-drive/drive.ts). */
export interface CallCounts {
  methods: Record<string, number>;
  /** `iterateFolderChildrenNodeUids`, per folder UID. */
  listings: Record<string, number>;
  /** `getNode` and `iterateNodes`, per node UID loaded. */
  nodeLoads: Record<string, number>;
  /** `getFileDownloader`, per node UID. */
  downloads: Record<string, number>;
}

/** The sign-ins and refreshes the account saw (`AccountReport` in fake-drive/account.ts). */
export interface AccountReport {
  signIns: { started: number; approved: number; pending: number };
  refreshes: { used: string; outcome: "rotated" | "refused" }[];
  refuseNextRefresh: boolean;
}

export type FaultKind = "rate-limited" | "server-error" | "unreachable" | "integrity" | "name-clash" | "upload-part-way";

/** A fault the next matching SDK call meets (fake-drive/faults.ts). */
export interface Fault {
  kind: FaultKind;
  operation: string;
  path: string;
}

/** The control channel answered with an error, or did not answer. */
export class ControlError extends Error {
  override name = "ControlError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class Control {
  constructor(readonly url: URL) {}

  /** The control channel a process printed, if it printed one. */
  static fromOutput(output: string): Control | undefined {
    const match = CONTROL_LINE.exec(output);
    return match ? new Control(new URL(match[1]!)) : undefined;
  }

  node(path: string): Promise<NodeInfo> {
    return this.json("GET", "node", { path });
  }

  /** The node at `path`, or undefined when the Drive holds none there outside the trash. */
  async nodeIfAny(path: string): Promise<NodeInfo | undefined> {
    try {
      return await this.node(path);
    } catch (error: unknown) {
      if (error instanceof ControlError && error.status === 404) return undefined;
      throw error;
    }
  }

  async content(path: string, revision?: string): Promise<Uint8Array> {
    const response = await this.request("GET", "content", revision ? { path, revision } : { path });
    return new Uint8Array(await response.arrayBuffer());
  }

  revisions(path: string): Promise<RevisionInfo[]> {
    return this.json("GET", "revisions", { path });
  }

  trashed(): Promise<NodeInfo[]> {
    return this.json("GET", "trash");
  }

  calls(): Promise<CallCounts> {
    return this.json("GET", "calls");
  }

  addFile(path: string, content: string): Promise<{ uid: string }> {
    return this.json("POST", "add", undefined, { path, type: "file", content });
  }

  trash(path: string): Promise<{ uid: string }> {
    return this.json("POST", "trash", undefined, { path });
  }

  /** Polls the event scheduler the binary asked for. Returns the scopes it polled. */
  fireEvents(): Promise<{ scopes: string[] }> {
    return this.json("POST", "events/fire");
  }

  advanceClock(seconds: number): Promise<{ now: number; fired: number }> {
    return this.json("POST", "clock/advance", undefined, { seconds });
  }

  addFault(fault: Fault): Promise<{ pending: Fault[] }> {
    return this.json("POST", "faults", undefined, fault);
  }

  account(): Promise<AccountReport> {
    return this.json("GET", "account");
  }

  approveSignIn(): Promise<{ approved: number }> {
    return this.json("POST", "account/approve");
  }

  expireAccessToken(): Promise<{ expired: number }> {
    return this.json("POST", "account/expire");
  }

  refuseNextRefresh(): Promise<{ refuseNextRefresh: true }> {
    return this.json("POST", "account/refuse-next-refresh");
  }

  private async json<T>(method: string, route: string, query?: Record<string, string>, body?: unknown): Promise<T> {
    const response = await this.request(method, route, query, body);
    return (await response.json()) as T;
  }

  private async request(method: string, route: string, query?: Record<string, string>, body?: unknown): Promise<Response> {
    const url = new URL(route, this.url);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error: unknown) {
      throw new ControlError(`the control channel at ${this.url.href} did not answer ${method} /${route}: ${String(error)}`);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new ControlError(`the control channel answered ${method} ${url.pathname}${url.search} with ${response.status}: ${text}`, response.status);
    }
    return response;
  }
}
