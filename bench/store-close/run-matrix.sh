#!/bin/bash
# Run the store-close matrix: N stores × M links × flush × allocator.
# Every run takes the shared measurement lock on its own and records the load
# average at its start. One JSON line per run goes to $OUT/runs.jsonl.
#
# Usage: bench/store-close/run-matrix.sh <out-dir> [scratch-dir]
#   NS="50 200" MS="0 1000 10000" FLUSHES="0 1" ALLOCS="glibc jemalloc jemalloc-conf" SETTLE=5 LOCKED=0
#
# Allocators:
#   glibc          the system malloc
#   jemalloc       built like the ADAM executor (unprefixed tikv-jemallocator,
#                  exports `_rjem_malloc_conf` the way ADAM does)
#   jemalloc-conf  the same binary with MALLOC_CONF set to ADAM's intended
#                  options (background purge, 1 s decay)
#
# The bench does not delete its stores: each run leaves <scratch>/run-<pid>-<ms>/.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?out dir}"
SCRATCH="${2:-$HERE/scratch}"
NS="${NS:-50 200}"
MS="${MS:-0 1000 10000}"
FLUSHES="${FLUSHES:-0 1}"
ALLOCS="${ALLOCS:-glibc jemalloc jemalloc-conf}"
SETTLE="${SETTLE:-5}"
ADAM_CONF="background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000"
# LOCKED=1: the caller already holds the measurement lock for the whole batch
# (e.g. `MS=1000 LOCKED=1 flock /tmp/arcadia-measure.lock run-matrix.sh …`),
# so rows do not queue for it one by one. The load average is still per row.
if [ "${LOCKED:-0}" = 1 ]; then LOCK_PREFIX=(); else LOCK_PREFIX=(flock /tmp/arcadia-measure.lock); fi
# 200 RocksDB stores need far more than the 1024 open files a systemd user unit
# gets by default (the bench fails at once with no JSON). Use the hard limit.
ulimit -n "$(ulimit -Hn)"
mkdir -p "$OUT" "$SCRATCH"
for m in $MS; do
  for n in $NS; do
    for flush in $FLUSHES; do
      for alloc in $ALLOCS; do
        label="n${n}-m${m}-flush${flush}-${alloc}"
        case "$alloc" in
          glibc) bin="$HERE/target/store-close-glibc"; envs=() ;;
          jemalloc) bin="$HERE/target/store-close-jemalloc"; envs=() ;;
          jemalloc-conf) bin="$HERE/target/store-close-jemalloc"; envs=("MALLOC_CONF=$ADAM_CONF") ;;
          *) echo "unknown allocator $alloc" >&2; exit 2 ;;
        esac
        # Resume: skip a row that already has a good result in this out dir.
        if [ -f "$OUT/runs.jsonl" ] && grep -F "\"label\":\"$label\"" "$OUT/runs.jsonl" | grep -qvF '"error"'; then
          echo "$(date -Is) skip $label (already done)" >&2
          continue
        fi
        echo "$(date -Is) start $label" >&2
        line=$("${LOCK_PREFIX[@]}" bash -c 'load=$(cat /proc/loadavg); out=$(env "$@" 2>/dev/null | tail -1); printf "%s\t%s\n" "$load" "$out"' _ \
          "${envs[@]}" "$bin" --n "$n" --m "$m" --flush "$flush" --dir "$SCRATCH" --settle-secs "$SETTLE" --label "$label")
        load="${line%%$'\t'*}"
        json="${line#*$'\t'}"
        if [ -z "$json" ] || [ "${json:0:1}" != "{" ]; then
          echo "{\"label\":\"$label\",\"error\":\"no JSON output\",\"loadavg_start\":\"$load\"}" >> "$OUT/runs.jsonl"
          echo "$(date -Is) FAILED $label" >&2
          continue
        fi
        echo "{\"loadavg_start\":\"$load\",\"alloc_variant\":\"$alloc\",${json:1}" >> "$OUT/runs.jsonl"
        echo "$(date -Is) done $label" >&2
      done
    done
  done
done
echo "$(date -Is) matrix finished" >&2
