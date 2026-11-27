#!/usr/bin/env bash
# ci:commit:node-modules-hash: build the package's node_modules derivation from scratch and check
# its fixed-output hash (nix/package.nix `outputHash`). Nix finds a fixed-output path by its hash,
# so a stale hash with an old output in a cache or the local store builds without error, and
# ships the old dependencies. `--rebuild` runs `bun install` again and fails on a hash mismatch.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

attr=".#protium-drive.nodeModules"

# --rebuild needs the output in the local store, so get it first (substitute or build).
nix build --no-link --print-build-logs "$attr"
exec nix build --no-link --print-build-logs --rebuild "$attr"
