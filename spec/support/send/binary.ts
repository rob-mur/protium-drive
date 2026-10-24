// The Send arm's command-line half. It runs the proton-drive-mount binary the way a user runs it,
// and nothing else in the suite starts a process of the product. The acceptance task builds the
// package from the deployed revision and names its executable and that revision in the
// environment, so no step definition names a path or a rev.
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

export interface Answer {
  exitCode: number;
  stdout: string;
  stderr: string;
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

  run(args: string[]): Answer {
    const result = spawnSync(this.path, args, { encoding: "utf8", timeout: 30_000 });
    if (result.error) throw result.error;
    return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }
}
