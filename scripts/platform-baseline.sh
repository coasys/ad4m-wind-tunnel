#!/usr/bin/env bash
# Platform baseline: what one hosted ADAM executor costs.
#
# Runs the p-family scenarios (p1–p5) against one executor binary, with
# Holochain off and on, each repeated REPEAT times, then writes SUMMARY.md
# with the spread across runs.
#
#   EXECUTOR=/path/to/ad4m-executor LABEL=dev-<sha> scripts/platform-baseline.sh
#
# Env:
#   EXECUTOR      ad4m-executor binary (required)
#   LABEL         branch label prefix; results go to $RESULTS/$LABEL-hc-{off,on}/
#   RESULTS       results dir (default results/platform-baseline-<date>)
#   REPEAT        runs per headline scenario (default 3)
#   REPEAT_HC_ON  runs for the Holochain-on space scenarios (default 1)
#   STEPS         space-separated subset of steps to run (default: all, in order)
#   Scenario tunables (P1_*, P2_*, ...) pass through; see README.
#
# Needs: a link-server on LINK_SERVER_URL (default http://127.0.0.1:3456) for
# the neighbourhood steps (they skip honestly without it), and the server link
# language bundle (SERVER_LINK_LANGUAGE_BUNDLE or AD4M_REPO/bootstrap-languages/...).
#
# Wrap long runs in a memory-capped user unit, for example:
#   systemd-run --user --unit=wt-platform --collect -p MemoryMax=16G -p MemorySwapMax=0 \
#     bash -c 'exec > run.log 2>&1; EXECUTOR=... scripts/platform-baseline.sh'
set -euo pipefail

cd "$(dirname "$0")/.."
: "${EXECUTOR:?set EXECUTOR to an ad4m-executor binary}"
LABEL=${LABEL:-platform}
RESULTS=${RESULTS:-results/platform-baseline-$(date +%F)}
REPEAT=${REPEAT:-3}
REPEAT_HC_ON=${REPEAT_HC_ON:-1}
STEPS=${STEPS:-"p1-off p1-on p2p-off p2n-off p3-off p4-off p5-off p2p-on p2n-on p3-on p4-on p5-on"}

RESULTS=$(realpath -m "$RESULTS")
mkdir -p "$RESULTS/logs"
export AD4M_WT_EXECUTOR_LOG_DIR="$RESULTS/logs/executor"

run() { # <scenario> <hc on|off> <repeat>
  local scenario=$1 hc=$2 repeat=$3
  local flag=false; [ "$hc" = on ] && flag=true
  echo "=== $(date -Is) $scenario holochain=$hc repeat=$repeat load=$(cut -d' ' -f1-3 /proc/loadavg)"
  npx tsx src/main.ts --scenario "$scenario" --skip-build --executor-path "$EXECUTOR" \
    --branch "$LABEL-hc-$hc" --run-holochain "$flag" --repeat "$repeat" --results-dir "$RESULTS" \
    || echo "!!! $scenario holochain=$hc exited non-zero"
}

for step in $STEPS; do
  case $step in
    p1-off)  run p1 off "$REPEAT" ;;
    p1-on)   run p1 on "$REPEAT" ;;
    p2p-off) run p2-perspectives off "$REPEAT" ;;
    p2n-off) run p2-neighbourhoods off "$REPEAT" ;;
    p3-off)  run p3 off "$REPEAT" ;;
    p4-off)  run p4 off "$REPEAT" ;;
    p5-off)  run p5 off "$REPEAT" ;;
    p2p-on)  run p2-perspectives on "$REPEAT_HC_ON" ;;
    p2n-on)  run p2-neighbourhoods on "$REPEAT_HC_ON" ;;
    p3-on)   run p3 on "$REPEAT_HC_ON" ;;
    p4-on)   run p4 on "$REPEAT_HC_ON" ;;
    p5-on)   run p5 on "$REPEAT_HC_ON" ;;
    *) echo "unknown step $step" >&2; exit 2 ;;
  esac
done

npx tsx src/platform/summarize.ts "$RESULTS"
echo "=== $(date -Is) done"
