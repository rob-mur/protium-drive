#!/usr/bin/env bash
set -euo pipefail

: "${API:?}"
: "${PR_NUMBER:?}"
: "${GATE_REVIEWER:?}"

PAGE_LIMIT=${PAGE_LIMIT:-50}

TIMING_MARKER='<!-- cd-pipeline: time-budget-stop (#316) -->'

page_body=$(mktemp)
trap 'rm -f "$page_body"' EXIT

if [ -z "${FJ_TOKEN:-}" ]; then
  echo "acknowledgement-gate: refused: the CD_PIPELINE_TOKEN secret is empty, so no identity can post the stop"
  exit 1
fi
echo "::add-mask::$FJ_TOKEN"

page=1
found=no
while [ "$page" -le 20 ]; do
  url="$API/pulls/$PR_NUMBER/reviews?limit=$PAGE_LIMIT&page=$page"
  if ! status=$(curl -sS --connect-timeout 10 --max-time 60 -o "$page_body" -w '%{http_code}' \
    -H "Authorization: token $FJ_TOKEN" "$url"); then
    echo "acknowledgement-gate: refused: reading $url failed before any HTTP status arrived"
    exit 1
  fi
  if [ "$status" != "200" ]; then
    echo "acknowledgement-gate: refused: listing reviews returned HTTP $status, so this run cannot tell whether the stop is already posted"
    head -c 400 "$page_body"
    exit 1
  fi
  if ! jq -e 'type == "array"' "$page_body" >/dev/null; then
    echo "acknowledgement-gate: refused: listing reviews returned HTTP 200 but no review list, so this run cannot tell whether the stop is already posted"
    head -c 400 "$page_body"
    exit 1
  fi
  if jq -e --arg reviewer "$GATE_REVIEWER" --arg marker "$TIMING_MARKER" \
    'any(.[]; .user.login == $reviewer and ((.body // "") | contains($marker) | not))' \
    "$page_body" >/dev/null; then
    found=yes
    break
  fi
  if jq -e 'length == 0' "$page_body" >/dev/null; then
    break
  fi
  page=$((page + 1))
done

echo "existing_review_by_$GATE_REVIEWER=$found"

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "GATE_ALREADY_POSTED=$found" >>"$GITHUB_ENV"
fi
