#!/usr/bin/env bash
set -euo pipefail

: "${API:?}"
: "${RUN_NUMBER:?}"
: "${COMMIT_BUDGET:?}"
: "${ACCEPTANCE_BUDGET:?}"
: "${MAIN_BUDGET:?}"

PAGE_LIMIT=${PAGE_LIMIT:-50}
MAX_PAGES=${MAX_PAGES:-6}

# rob/proton-drive-mount is private, so an anonymous read answers 404. The reading carries the
# job's own token (READING_TOKEN) when the job has it: it reads this repository and nothing else,
# and it needs no account the stop posts as to be a collaborator. rob/continuous-delivery's copy
# at the pinned `stable` reads anonymously: that repository is public
# (rob/continuous-delivery#659).
auth=()
if [ -n "${READING_TOKEN:-}" ]; then
  auth=(-H "Authorization: token $READING_TOKEN")
fi

page_body=$(mktemp)
merged=$(mktemp)
runs=$(mktemp)
tasks=$(mktemp)
trap 'rm -f "$page_body" "$merged" "$runs" "$tasks"' EXIT

read_window() {
  local endpoint=$1 out=$2 enough=$3
  local page=1 url status count

  echo '[]' >"$out"
  while [ "$page" -le "$MAX_PAGES" ]; do
    url="$API/actions/$endpoint?limit=$PAGE_LIMIT&page=$page"

    if ! status=$(curl -sS --connect-timeout 10 --max-time 60 -o "$page_body" -w '%{http_code}' "${auth[@]}" "$url"); then
      echo "time-budgets: refused: reading $url failed before any HTTP status arrived"
      exit 1
    fi
    if [ "$status" != "200" ]; then
      echo "time-budgets: refused: GET $url returned HTTP $status, so this run cannot read the timings"
      head -c 400 "$page_body"
      exit 1
    fi
    if ! jq -e '.workflow_runs | type == "array"' "$page_body" >/dev/null; then
      echo "time-budgets: refused: GET $url returned HTTP 200 but no 'workflow_runs' array, so this run cannot read the timings"
      head -c 400 "$page_body"
      exit 1
    fi

    jq -s '.[0] + .[1].workflow_runs' "$out" "$page_body" >"$merged"
    mv "$merged" "$out"

    if jq -e --argjson run "$RUN_NUMBER" "$enough" "$out" >/dev/null; then
      break
    fi

    count=$(jq '.workflow_runs | length' "$page_body")
    if [ "$count" -ne "$PAGE_LIMIT" ]; then
      break
    fi
    page=$((page + 1))
  done
}

read_window runs "$runs" '
  ([.[] | select(.index_in_repo == $run)] | length) >= 1
  and ([.[] | select(.workflow_id == "main.yml" and .prettyref == "main"
                     and (.status == "success" or .status == "failure"))]
       | length) >= 1'

read_window tasks "$tasks" '
  ([.[] | select(.run_number == $run and .workflow_id == "merge-request.yml"
                 and (.name == "ci:commit" or .name == "ci:acceptance"))]
   | length) >= 2'

echo "time-budgets: run $RUN_NUMBER read $(jq length "$runs") run(s) and $(jq length "$tasks") task(s) from $API/actions"
echo

jq -n -r \
  --slurpfile runs "$runs" \
  --slurpfile tasks "$tasks" \
  --argjson run "$RUN_NUMBER" \
  --argjson commit_budget "$COMMIT_BUDGET" \
  --argjson acceptance_budget "$ACCEPTANCE_BUDGET" \
  --argjson main_budget "$MAIN_BUDGET" '
  def signed: if . >= 0 then "+\(.)" else "\(.)" end;
  def verdict: if . > 0 then "over" else "within" end;
  def span($from; $to): ($to | fromdateiso8601) - ($from | fromdateiso8601);
  def against($label; $measured; $budget):
    "\($label): measured \($measured)s, budget \($budget)s, "
    + "delta \($measured - $budget | signed)s, \($measured - $budget | verdict) budget";
  def judged($label; $task; $budget):
    if $task == null
    then "\($label): run \($run) has no finished task named \($label) in the window read, so there is nothing to measure"
    else against($label; span($task.run_started_at; $task.updated_at); $budget)
    end;

  ($runs[0]) as $all_runs
  | ($tasks[0] | map(select(.run_number == $run and .workflow_id == "merge-request.yml"))) as $mine
  | ($mine | map(select(.name == "ci:commit")) | first) as $commit
  | ($mine | map(select(.name == "ci:acceptance")) | first) as $acceptance
  | ($all_runs | map(select(.index_in_repo == $run)) | first) as $self
  | ($all_runs
     | map(select(.workflow_id == "main.yml" and .prettyref == "main"
                  and (.status == "success" or .status == "failure")))
     | first) as $main
  | judged("ci:commit"; $commit; $commit_budget),
    judged("ci:acceptance"; $acceptance; $acceptance_budget),
    (if $self == null
     then "queue: run \($run) is not in the window read, so its queue wait cannot be shown"
     else "queue: run \($run) waited \(span($self.created; $self.started))s for a runner "
          + "before either stage above started, not judged"
     end),
    (if $main == null
     then "main: no main.yml run that reached success or failure in the window read, so this merge request carries no main verdict"
     else against("main: run \($main.index_in_repo), queued to finished, every job of it included";
                  span($main.created; $main.stopped); $main_budget)
     end)
'

echo
echo "time-budgets: the three numbers are targets and not thresholds. Nothing here fails on the clock, this reading posts no review, and no merge is refused whatever the deltas say. A breach draws one acknowledgement from the 'time-budget-stop' job, which a human dismisses once."
