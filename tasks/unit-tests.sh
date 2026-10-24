#!/usr/bin/env bash
# ci:commit:unit-tests: the unit tests beside the code, in src/ (`*.test.ts`, declared
# non-production in cd-pipeline/freeze-manifest.json) and in fake-drive/, the test-only Receive
# arm (frozen lane). A tree with no unit test yet passes: the skeleton holds none, and each
# ticket adds the ones its code needs.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

bun install --frozen-lockfile
exec bun test --pass-with-no-tests src fake-drive
