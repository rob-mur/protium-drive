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

      acceptance.tasks.frozen-suite.exec = ''
        echo "ci:acceptance:frozen-suite: cd-pipeline ships no suite runner for step definitions that are not Rust, so nothing here can apply spec/frozen.lock.json and the ratchet to the cucumber-js suite in spec/. Waiting on rob/continuous-delivery#653."
        exit 1
      '';

      non-functional-requirements.tasks.spec-reach.exec = ''
        echo "ci:non-functional-requirements:spec-reach: cd-pipeline writes no production diff and gates no spec reach yet, so nothing here measures which production lines the frozen suite executes. Waiting on rob/continuous-delivery#652 (epic #112)."
        exit 1
      '';
    };
  };
}
