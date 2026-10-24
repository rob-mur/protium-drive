#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

: "${CI_ENVIRONMENT:?ci:deploy: CI_ENVIRONMENT names the environment}"
: "${CI_ENTRY_POINT:?ci:deploy: CI_ENTRY_POINT names the trigger}"
: "${CI_BRANCH:?ci:deploy: CI_BRANCH names the ref the run was triggered on}"

say() { echo "ci:deploy:source-member: $*"; }

record=.ci/release.json

if [ "$CI_ENTRY_POINT" = promotion ]; then
  : "${CI_RELEASE:?ci:deploy: CI_RELEASE names the release a promotion deploys}"
  case "$CI_ENVIRONMENT" in
    v*)
      say "the target $CI_ENVIRONMENT takes the shape a release cut takes, v*, and the tag move below is forced, so a promotion into it would overwrite the proof a release is"
      exit 1
      ;;
  esac
  rev=$(git rev-parse --verify --quiet "refs/tags/$CI_RELEASE^{commit}") || {
    say "the checkout holds no release named $CI_RELEASE, so there is nothing to promote"
    exit 1
  }
  say "the release $CI_RELEASE names $rev"
  if [ ! -f "$record" ]; then
    say "the checkout holds no $record, so the commit set $CI_RELEASE covered cannot be read and the deploy event would under-report lead time for changes"
    exit 1
  fi
  recorded=$(jq -r .tag "$record" 2>/dev/null) || recorded=
  if [ "$recorded" != "$CI_RELEASE" ]; then
    say "$record holds the record of $recorded and this promotion deploys $CI_RELEASE, so the commit set it carries covers another release"
    exit 1
  fi
  promotion_fields=$(jq -c --arg release "$CI_RELEASE" \
    '{release: $release, changes: .commits}' "$record")
  say "the record of $CI_RELEASE carries $(jq '.commits | length' "$record") commits, copied into the deploy event as they stand"
else
  rev=$(git rev-parse HEAD)
  promotion_fields='{}'
fi

rendezvous="tree-$(git rev-parse "$rev^{tree}")"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

outcome=error

event=.ci/deploy-event.json

write_deploy_event() {
  local stopped
  stopped=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mkdir -p "$(dirname "$event")"
  jq -n \
    --arg commit "$rev" \
    --arg rendezvous_name "$rendezvous" \
    --arg environment "$CI_ENVIRONMENT" \
    --arg entry_point "$CI_ENTRY_POINT" \
    --arg branch "$CI_BRANCH" \
    --arg outcome "$outcome" \
    --arg runner_started_at "$started" \
    --arg runner_stopped_at "$stopped" \
    --argjson promotion_fields "$promotion_fields" \
    '($ARGS.named | del(.promotion_fields)) + $promotion_fields' >"$event"
  say "the deploy event is at $event, outcome $outcome"
  cat "$event"
}

trap write_deploy_event EXIT

say "deploying $rev to $CI_ENVIRONMENT, entry point $CI_ENTRY_POINT, branch $CI_BRANCH"

if [ "$CI_ENTRY_POINT" = promotion ]; then
  say "moving the $CI_ENVIRONMENT tag to $rev, forced, because a rollback names an earlier release and the tag has to move backwards"
  git push --force origin "$rev:refs/tags/$CI_ENVIRONMENT"
else
  say "no environment tag moves: only a promotion is asked for a chosen release"
fi

say "a promotion pushes the $CI_ENVIRONMENT tag and every other entry point pushes nothing: releasable does not move here"

outcome=pass
