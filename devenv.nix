{
  pkgs,
  lib,
  config,
  ...
}:

{
  packages = [
    pkgs.actionlint
    pkgs.bun
    pkgs.coreutils
    # The mount runs fusermount3 to clear a mountpoint that a killed mount left mounted.
    pkgs.fuse3.bin
    pkgs.git
    pkgs.jq
    pkgs.rclone
    # cd-acceptance-diff reads and publishes the acceptance record with skopeo.
    pkgs.skopeo
  ];

  cd-pipeline = {
    typescript.enable = true;

    # A consumer builds the flake's own package at the deployed rev and runs it.
    consumerKind = "flake-package";

    records.prefix = "europe-west1-docker.pkg.dev/ai-ci-pipeline";
    records.namespace = "proton-drive-mount";

    # The FUSE acceptance scenarios mount through /dev/fuse, and only this runner's job pod has it.
    forge.runners.merge-request.acceptance = "nix-host-2cpu-4gb-fuse";
    forge.runners.main.acceptance = "nix-host-2cpu-4gb-fuse";

    frozenSuite = {
      command = [ "bun" "spec/node_modules/.bin/cucumber-js" "--config" "spec/cucumber.mjs" ];
      install = "cd spec && bun install --frozen-lockfile";
      sourceMember = {
        path = "bin/proton-drive-mount";
        variable = "PDM_BINARY";
        revisionVariable = "PDM_REVISION";
      };
    };

    # Spec reach on a merge request: cd-pipeline's own script runs the frozen suite against the
    # member built with coverage and writes the LCOV that ci:acceptance:spec-reach reads.
    coverage.run = [ (lib.getExe config.cd-pipeline.coverage.scripts.javascript.cucumber-js) ];

    verbs = {
      commit.tasks.workflows.exec = ''
        exec actionlint -config-file tasks/actionlint.yaml -- .forgejo/workflows/*.yml
      '';

      commit.tasks.typecheck.exec = ''
        set -eu
        bun install --frozen-lockfile
        exec bun x tsc --noEmit
      '';

      commit.tasks.spec-typecheck.exec = ''
        set -eu
        cd spec
        bun install --frozen-lockfile
        exec bun x tsc --noEmit -p .
      '';

      # After typecheck: both run bun install in the root, and two installs at once into one
      # node_modules/ fail ("failed copying files from cache to destination").
      commit.tasks.unit-tests.after = [ "ci:commit:typecheck" ];
      commit.tasks.unit-tests.exec = ''
        exec tasks/unit-tests.sh
      '';

      # A source member publishes no bytes: the flake at a rev is what a consumer takes.
      artifact = null;

      deploy.tasks.source-member.exec = ''
        exec cd-deploy-source-member
      '';

      deploy.teardown.exec = ''
        echo "ci:deploy:teardown: a source member has no environment to tear down"
      '';

      # The stub passes and judges nothing, as cd-pipeline's own stub for an unbuilt verb does.
      non-functional-requirements.tasks.spec-reach.exec = ''
        echo "ci:non-functional-requirements:spec-reach: not implemented. cd-pipeline v1.11.0 measures spec reach through cd-pipeline.coverage.run, a substitute run script the adopter writes: it builds the member instrumented, runs the acceptance suite against it, writes LCOV and prints one verdict line per scenario. cd-pipeline ships no such script for a Bun source member whose frozen suite runs through cd-frozen-suite, so this run measures no spec reach. The task waits on continuous-delivery owning that run."
      '';
    };
  };
}
