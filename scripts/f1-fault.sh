#!/bin/bash
# F1 fault-injection sweep: SDK client mode at every level, then legacy client
# mode at the levels that matter. Each run holds the shared measurement lock
# and records the load average at its start.
#
# Usage: EXECUTOR=/path/to/ad4m-executor RESULTS=results/<dir> scripts/f1-fault.sh
#   LEVELS=1,4,20,100  LEGACY_LEVELS=20,100 (empty = skip legacy)  LABEL=f1  BASE_PORT=12400
#   plus any F1_* tunable (see README).
# Run it under a memory cap:
#   systemd-run --user --unit=hex-wt-f1 --collect -p MemoryMax=32G -p MemorySwapMax=0 \
#     --working-directory=$PWD bash -c 'exec > f1.log 2>&1; EXECUTOR=… RESULTS=… scripts/f1-fault.sh'
set -uo pipefail
cd "$(dirname "$0")/.."
: "${EXECUTOR:?set EXECUTOR to the ad4m-executor binary}"
: "${RESULTS:?set RESULTS to the results dir}"
LEVELS="${LEVELS:-1,4,20,100}"
LEGACY_LEVELS="${LEGACY_LEVELS-20,100}"
LABEL="${LABEL:-f1}"
BASE_PORT="${BASE_PORT:-12400}"
TSX="$PWD/node_modules/.bin/tsx"
TMP="${AD4M_WT_TMPDIR:-/tmp/hex-wt-f1}"
mkdir -p "$RESULTS" "$TMP"

run() {
  local mode="$1" levels="$2" branch="$3"
  echo "$(date -Is) start $branch mode=$mode levels=$levels"
  flock /tmp/arcadia-measure.lock bash -c 'echo "loadavg at start: $(cat /proc/loadavg)"; exec env "$@"' _ \
    F1_CLIENT_MODE="$mode" F1_LEVELS="$levels" "$TSX" src/main.ts --scenario f1 --skip-build \
    --executor-path "$EXECUTOR" --run-holochain false --branch "$branch" --results-dir "$RESULTS" --tmp-dir "$TMP" --base-port "$BASE_PORT"
  echo "$(date -Is) exit $? $branch"
}

run sdk "$LEVELS" "$LABEL-sdk"
if [ -n "$LEGACY_LEVELS" ]; then
  run legacy "$LEGACY_LEVELS" "$LABEL-legacy"
fi
