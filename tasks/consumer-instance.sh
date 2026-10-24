#!/usr/bin/env bash
# The serving check of a source member (cd-pipeline's adoption contract, HP5, "Library, SDK,
# flake"): a consumer instance resolves the rev the deploy asked for from the forge, cold, into a
# throwaway store, then builds the flake's package at that rev and runs it.
#
# Adapted from rob/continuous-delivery's tasks/consumer-instance.sh at the pinned `stable`. Two
# differences: the consumer here is the flake's own package, not a devenv shell that imports a
# module, and rob/proton-drive-mount is a private repository, so the fetch carries the forge
# credential the checkout holds. The credential reaches nix's git through GIT_CONFIG_* and is
# never printed.
set -euo pipefail

rev=${1:?consumer-instance.sh: give it a rev}
ref=${2:?consumer-instance.sh: give it a ref the rev is reachable on}

forge=https://forgejo.clarob.uk
url=$forge/rob/proton-drive-mount
pin="git+$url?ref=$ref&rev=$rev"

say() { echo "consumer-instance: $*"; }

not_serving() {
  say "NOT SERVING: $*"
  exit 20
}

headers=$(git config --local --get-regexp '^http\..*extraheader$' 2>/dev/null || true)
n=0
while IFS= read -r line; do
  test -n "$line" || continue
  export "GIT_CONFIG_KEY_$n=http.$forge/.extraheader"
  export "GIT_CONFIG_VALUE_$n=${line#* }"
  n=$((n + 1))
done <<<"$headers"
export GIT_CONFIG_COUNT=$n
if [ "$n" -eq 0 ]; then
  say "the checkout carries no forge credential, and $url is private, so the fetch below has none"
else
  say "the fetch carries the $n forge credential(s) the checkout holds"
fi

work=$(mktemp -d -t pdm-consumer-instance-XXXXXXXX)
trap 'chmod -R u+w "$work" 2>/dev/null || true; rm -rf "$work"' EXIT
say "the consumer instance lives at $work, and this trap removes it"

store="$work/throwaway-store"
mkdir -p "$store/nix/store"
held=$(find "$store/nix/store" -mindepth 1 -maxdepth 1 | wc -l)
test "$held" -eq 0 || {
  say "the throwaway store is not empty: it holds $held path(s)"
  exit 1
}
say "the throwaway store is empty"

say "resolving $url at $rev, on $ref"
if ! fetched=$(nix eval --json --store "local?root=$store" --expr "
  let
    src = builtins.fetchGit {
      url = \"$url\";
      ref = \"$ref\";
      rev = \"$rev\";
    };
  in
  {
    inherit (src) rev;
    path = src.outPath;
  }
"); then
  not_serving "the rev does not resolve from $url"
fi

locked=$(printf '%s' "$fetched" | jq -r '.rev')
path=$(printf '%s' "$fetched" | jq -r '.path')

test "$locked" = "$rev" ||
  not_serving "the fetch locked $locked and not $rev"
say "the rev resolves: $locked"

test -e "$store$path" || {
  say "the fetch did not land in the throwaway store: $store$path is absent"
  exit 1
}
say "the fetch landed in the throwaway store: $store$path"

test -e "$store$path/flake.nix" ||
  not_serving "the rev carries no flake.nix, so a consumer has nothing to build"

say "the consumer instance builds $pin#default"
if ! out=$(nix build --no-link --print-out-paths "$pin#default"); then
  not_serving "the flake's default package does not build at $rev"
fi
say "the package built: $out"

binary="$out/bin/proton-drive-mount"
test -x "$binary" ||
  not_serving "the package holds no executable at bin/proton-drive-mount"

if ! version=$("$binary" --version); then
  not_serving "$binary --version exits non-zero"
fi
say "$binary --version answers: $version"

say "SERVING: a consumer instance resolves $rev and uses what it gets"
