// The Send arm's command-line half. It runs the proton-drive-mount binary the way a user runs it,
// and nothing else in the suite starts a process of the product. The acceptance task builds the
// package from the deployed revision and names its executable and that revision in the
// environment, so no step definition names a path or a rev.
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

import { type Running, start } from "@cd-pipeline/support";

export type { Running } from "@cd-pipeline/support";

export interface Answer {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Where a run of the binary keeps its home, so no run reads or writes the user's own. */
export interface Home {
  /** `HOME`, and the base of every XDG directory. */
  home: string;
}

/**
 * The environment of every run of the binary: the suite's own, a home of the scenario's, and a
 * proxy that refuses every connection. The suite never reaches Proton: under `--fake-drive` the
 * binary makes no request of its own, and a command that runs without the switch and tries one
 * meets the refusing proxy rather than Proton.
 */
function environment(home: Home | undefined): NodeJS.ProcessEnv {
  const refused = "http://127.0.0.1:9";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HTTP_PROXY: refused,
    HTTPS_PROXY: refused,
    http_proxy: refused,
    https_proxy: refused,
    NO_PROXY: "",
    no_proxy: "",
  };
  if (home) {
    env.HOME = home.home;
    env.XDG_STATE_HOME = `${home.home}/.local/state`;
    env.XDG_CONFIG_HOME = `${home.home}/.config`;
    env.XDG_CACHE_HOME = `${home.home}/.cache`;
    env.XDG_DATA_HOME = `${home.home}/.local/share`;
  }
  return env;
}

export class Binary {
  private constructor(
    readonly path: string,
    readonly revision: string,
  ) {}

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): Binary {
    const path = env.PDM_BINARY;
    if (!path) {
      throw new Error(
        "PDM_BINARY is unset: the acceptance task sets it to bin/proton-drive-mount of the package built from the deployed revision",
      );
    }
    const revision = env.PDM_REVISION;
    if (!revision || !/^[0-9a-f]{40}$/.test(revision)) {
      throw new Error(
        `PDM_REVISION is '${revision ?? ""}': the acceptance task sets it to the full 40-character revision the package was built from`,
      );
    }
    return new Binary(path, revision);
  }

  isExecutable(): boolean {
    try {
      accessSync(this.path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Runs a command that ends on its own, and waits up to 30 s for it. */
  run(args: string[], home?: Home): Answer {
    const result = spawnSync(this.path, args, { encoding: "utf8", timeout: 30_000, env: environment(home) });
    if (result.error) throw result.error;
    return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * Starts a command that runs until it is stopped, such as `serve`. `variables` are set in its
   * environment on top of the suite's, as a user sets them in a shell or a service file.
   */
  start(args: string[], home?: Home, variables: Record<string, string> = {}): Running {
    return start(this.path, args, { env: { ...environment(home), ...variables } });
  }
}

/** Indents every line of `text`, for a failure message. */
export function indent(text: string): string {
  return text.replace(/^/gm, "    ");
}
