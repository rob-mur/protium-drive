#!/usr/bin/env bash
# vendor-sync: copy vendor/ again from ProtonDriveApps/sdk at the tag that vendor/README.md
# records on its "Upstream tag:" line. Renovate runs it after it moves that tag, through
# cd-post-upgrade (devenv.nix, cd-pipeline.renovate.postUpgradeCommands).
#
# vendor-sync --check writes nothing. It exits 1 when vendor/ differs from upstream at the tag,
# and ci:commit:vendor-drift runs it on every change.
#
# VENDOR_SYNC_UPSTREAM overrides the upstream git URL, for a test against a local repository.
set -euo pipefail

say() { echo "vendor-sync: $*"; }

mode="write"
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  *)
    say "usage: tasks/vendor-sync.sh [--check]"
    exit 2
    ;;
esac

root=$(git rev-parse --show-toplevel)
upstream=${VENDOR_SYNC_UPSTREAM:-https://github.com/ProtonDriveApps/sdk}

# shellcheck disable=SC2016 # the backticks are literal markdown
tag=$(sed -n 's/^Upstream tag: `\(js\/v[^`]*\)`$/\1/p' "$root/vendor/README.md")
if [ -z "$tag" ] || [ "$(printf '%s\n' "$tag" | wc -l)" -ne 1 ]; then
  say "REFUSED. vendor/README.md must hold exactly one line 'Upstream tag: \`js/v<version>\`'."
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The fetch reads no user or system git config, so a local rewrite of the URL (to ssh, say)
# cannot change where it fetches from, here or in CI.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0

# A shallow, blobless fetch of the tag, then a checkout of the vendored paths only, so the run
# downloads those files and not the whole monorepo.
git -C "$work" init -q
git -C "$work" remote add origin "$upstream"
git -C "$work" config remote.origin.promisor true
git -C "$work" config remote.origin.partialclonefilter blob:none
if ! git -C "$work" fetch -q --depth 1 --filter=blob:none origin "refs/tags/$tag"; then
  say "REFUSED. Could not fetch tag $tag from $upstream."
  exit 1
fi
git -C "$work" checkout -q FETCH_HEAD -- LICENSE.md incubating/account/js/src cli/src/api

# The expected vendor/ tree, built beside the checkout.
want="$work/want"
mkdir -p "$want/proton-drive-sdk-account" "$want/proton-drive-cli"
cp "$work/LICENSE.md" "$want/proton-drive-sdk-account/LICENSE.md"
cp "$work/LICENSE.md" "$want/proton-drive-cli/LICENSE.md"
for file in "$work"/incubating/account/js/src/*.ts; do
  case "$file" in *.test.ts) continue ;; esac
  cp "$file" "$want/proton-drive-sdk-account/"
done
for name in apiRequirements.ts messageEmitter.ts serverTimeHook.ts; do
  cp "$work/cli/src/api/$name" "$want/proton-drive-cli/"
done

drift=0
for dir in proton-drive-sdk-account proton-drive-cli; do
  if [ "$mode" = check ]; then
    if ! diff -r "$want/$dir" "$root/vendor/$dir"; then
      say "DRIFT. vendor/$dir differs from $upstream at $tag."
      drift=1
    fi
  else
    rm -rf "${root:?}/vendor/$dir"
    cp -r "$want/$dir" "$root/vendor/$dir"
  fi
done
if [ "$drift" -ne 0 ]; then
  say "Run tasks/vendor-sync.sh to copy vendor/ again."
  exit 1
fi

if [ "$mode" = check ]; then
  say "OK vendor/ equals $upstream at $tag."
else
  say "OK copied vendor/ from $upstream at $tag."
fi
