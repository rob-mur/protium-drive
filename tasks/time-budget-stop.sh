#!/usr/bin/env bash
set -euo pipefail

: "${API:?}"
: "${PR_NUMBER:?}"
: "${GATE_REVIEWER:?}"

READING=${READING:-tasks/time-budgets.sh}

PAGE_LIMIT=${PAGE_LIMIT:-50}

MARKER='<!-- cd-pipeline: time-budget-stop (#316) -->'

reading=$(mktemp)
breaches=$(mktemp)
page_body=$(mktemp)
body=$(mktemp)
payload=$(mktemp)
response=$(mktemp)
trap 'rm -f "$reading" "$breaches" "$page_body" "$body" "$payload" "$response"' EXIT

if [ -z "${FJ_TOKEN:-}" ]; then
  echo "time-budget-stop: refused: the CD_PIPELINE_TOKEN secret is empty, so no identity can post the stop"
  exit 1
fi
echo "::add-mask::$FJ_TOKEN"

if ! bash "$READING" >"$reading" 2>&1; then
  cat "$reading"
  echo "time-budget-stop: refused: the reading did not complete, so this run cannot tell whether a budget was breached"
  exit 1
fi
cat "$reading"
echo

grep -E 'over budget$' "$reading" >"$breaches" || true

if [ ! -s "$breaches" ]; then
  echo "time-budget-stop: every stage read is within budget, so there is nothing to stop."
  exit 0
fi

if [ "${PR_AUTHOR:-}" = "$GATE_REVIEWER" ]; then
  echo "time-budget-stop: '$GATE_REVIEWER' opened merge request #$PR_NUMBER and also posts the stop. Forgejo refuses a self-authored REQUEST_CHANGES with 422, so there is nothing to post."
  exit 0
fi

page=1
found=no
while [ "$page" -le 20 ]; do
  url="$API/pulls/$PR_NUMBER/reviews?limit=$PAGE_LIMIT&page=$page"
  if ! status=$(curl -sS --connect-timeout 10 --max-time 60 -o "$page_body" -w '%{http_code}' \
    -H "Authorization: token $FJ_TOKEN" "$url"); then
    echo "time-budget-stop: refused: reading $url failed before any HTTP status arrived"
    exit 1
  fi
  if [ "$status" != "200" ]; then
    echo "time-budget-stop: refused: GET $url returned HTTP $status, so this run cannot tell whether the stop is already posted"
    head -c 400 "$page_body"
    exit 1
  fi
  if ! jq -e 'type == "array"' "$page_body" >/dev/null; then
    echo "time-budget-stop: refused: GET $url returned HTTP 200 but no review list, so this run cannot tell whether the stop is already posted"
    head -c 400 "$page_body"
    exit 1
  fi
  if jq -e --arg reviewer "$GATE_REVIEWER" --arg marker "$MARKER" \
    'any(.[]; .user.login == $reviewer and ((.body // "") | contains($marker)))' \
    "$page_body" >/dev/null; then
    found=yes
    break
  fi
  if jq -e 'length == 0' "$page_body" >/dev/null; then
    break
  fi
  page=$((page + 1))
done

if [ "$found" = yes ]; then
  echo "time-budget-stop: merge request #$PR_NUMBER already carries this stop, posted or dismissed. Posting nothing: one stop per merge request, and a dismissed stop stays dismissed."
  exit 0
fi

{
  echo "$MARKER"
  echo
  echo "## A time budget is breached"
  echo
  echo "No check failed. Nothing here says the change is wrong, and nothing failed on the"
  echo "clock: the job that posted this review is green. This is a stop a human clears by"
  echo "reading, and it exists because a printed line is easy to miss."
  echo
  echo "**What was measured, against the budget \`README.md\` states:**"
  echo
  sed 's/^/    /' "$breaches"
  echo
  echo "**Before you dismiss it, read:**"
  echo
  echo "1. **Which stage grew, and against what.** The three budgets are targets and not"
  echo "   thresholds, and a breach is answered with engineering rather than with a failed"
  echo "   build."
  echo "2. **Whether this merge request caused it.** A budget is a wall clock, so a busy"
  echo "   runner or a slow queue can breach one on a diff that added no work."
  echo "3. **The \`main\` line, if it is here.** It is the last \`main\` run's hour, carried"
  echo "   onto this merge request because a \`main\` run has no merge request of its own."
  echo
  echo "Dismiss it in the web UI when you have read those. The dismissal is recorded with"
  echo "your name and the time, which is the whole of what this stop buys."
  echo
  echo "**It will not come back.** Once dismissed, further pushes to this branch leave the"
  echo "dismissal standing — a stop that returned after every push could never be cleared."
} >"$body"

jq -n --rawfile body "$body" '{event: "REQUEST_CHANGES", body: $body}' >"$payload"

if ! status=$(curl -sS --connect-timeout 10 --max-time 60 -o "$response" -w '%{http_code}' \
  -X POST \
  -H "Authorization: token $FJ_TOKEN" \
  -H "Content-Type: application/json" \
  --data @"$payload" \
  "$API/pulls/$PR_NUMBER/reviews"); then
  echo "time-budget-stop: refused: posting the review as '$GATE_REVIEWER' failed before any HTTP status arrived"
  exit 1
fi
if [ "$status" != "200" ]; then
  echo "time-budget-stop: refused: posting the review as '$GATE_REVIEWER' returned HTTP $status"
  head -c 400 "$response"
  exit 1
fi

cat "$breaches"
echo "time-budget-stop: the stop is on merge request #$PR_NUMBER, posted as '$GATE_REVIEWER', waiting for a human to read it and dismiss it."
