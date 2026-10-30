{
  pkgs,
  config,
  lib,
  ...
}:

{
  packages = [
    pkgs.actionlint
    pkgs.bun
    pkgs.coreutils
    pkgs.git
    pkgs.jq
    pkgs.rclone
    # cd-acceptance-diff reads and publishes the acceptance record with skopeo.
    pkgs.skopeo
  ];

  # Copied from rob/continuous-delivery's devenv.nix at the pinned `stable`, as the adoption
  # contract's copy table requires for acknowledgement-gate.yml. This project enables no
  # language module and no git hook, so the block keeps only what the gate's shell needs.
  profiles.acknowledgement-gate.module = {
    stdenv = lib.mkForce pkgs.stdenvNoCC;
    packages = lib.mkForce [
      config.cd-pipeline.builtins
      pkgs.coreutils
      pkgs.curl
      pkgs.gawk
      pkgs.gitMinimal
      pkgs.gnugrep
      pkgs.gnused
      pkgs.jq
    ];
  };

  cd-pipeline = {
    servingCheck = ''
      exec tasks/consumer-instance.sh "$CD_SERVING_REV" "$CD_SERVING_BRANCH"
    '';

    records.prefix = "europe-west1-docker.pkg.dev/ai-ci-pipeline/proton-drive-mount";

    frozenSuite = {
      command = [ "bun" "spec/node_modules/.bin/cucumber-js" "--config" "spec/cucumber.mjs" ];
      install = "cd spec && bun install --frozen-lockfile";
      sourceMember = {
        path = "bin/proton-drive-mount";
        variable = "PDM_BINARY";
        revisionVariable = "PDM_REVISION";
      };
    };

    verbs = {
      commit.tasks.expected-status.exec = ''
        exec cd-expected-status-gate
      '';

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
        exec tasks/deploy-source-member.sh
      '';

      deploy.teardown.exec = ''
        echo "ci:deploy:teardown: a source member has no environment to tear down"
      '';

      # The stub passes and judges nothing, as cd-pipeline's own stub for an unbuilt verb does.
      non-functional-requirements.tasks.spec-reach.exec = ''
        echo "ci:non-functional-requirements:spec-reach: not implemented. cd-pipeline v1.7.0 generates ci:acceptance:spec-reach only in a substitute invocation, and the adopter has to supply the instrumented substitute and the run that drives it, so this run measures no spec reach. The task waits on continuous-delivery owning the substitute run."
      '';
    };
  };
}
