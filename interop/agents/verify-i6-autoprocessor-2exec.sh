#!/usr/bin/env bash
#
# I6 (Auto-processor, two executors) — the min-DID `ProcessingClaim` race.
#
# Brings up TWO independent, hardened executors sharing a network + the mock
# LLM. Always-run portion: each executor independently registers the same
# model + subject class + auto-processor config and correctly runs exactly one
# batch pass over its OWN local channel — proving the mechanism itself does not
# somehow break under a multi-executor topology.
#
# The FULL claim assertion (two peers racing to process the SAME synced batch,
# exactly one winning by the lexicographically-smallest DID) needs a REAL,
# synced neighbourhood — Holochain-backed `perspective-diff-sync`. This harness
# carries no local `perspective-diff-sync` language artifact (ad4m-interp's JS
# test suite fetches/builds it via `pnpm run prepare-test`, out of reach here)
# and no verified way to confirm the I-series executor image even wires
# `RUN_HOLOCHAIN` — the #881 worktree's `docker-entrypoint.sh` never
# references it. So the cross-executor race stands as the untestable part this
# scenario explicitly allows a SKIP for, with a clear reason. It runs only
# opt-in: set I6_ATTEMPT_NEIGHBOURHOOD=1 and I6_DIFFSYNC_LANGUAGE_HASH=<hash of
# a published perspective-diff-sync language template> once both prerequisites
# exist — the driver then attempts a real publish/join and either passes the
# claim assertion for real or prints its own SKIP reason.
#
# Driven via the raw WS-RPC TS client. Hardened + host-isolated, full teardown.
# KEEP=1 leaves the pod up. Honest SKIP when the interpretation executor image
# stays absent.
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
EXE_IMG="${INTERP_EXEC_IMAGE:-ad4m-test-interp:latest}"
MOCK_IMG="interp-mockllm"
NET=i6-net
EXE1=i6-exec-alice
EXE2=i6-exec-bob
MOCK=i6-mock
ADMIN=windtunnel-admin
WS1_PORT=14651
WS2_PORT=14652
MOCK_PORT=14653
KEEP="${KEEP:-}"

if ! docker image inspect "$EXE_IMG" >/dev/null 2>&1; then
  echo "[i6] SKIP — no interpretation executor image ($EXE_IMG). Build it from the ad4m-interp #881 branch first."
  exit 0
fi

teardown() { [ -n "$KEEP" ] && { echo "[i6] KEEP set — leaving pod up"; return; }; docker rm -f "$EXE1" "$EXE2" "$MOCK" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap teardown EXIT

echo "[i6] clean slate"; docker rm -f "$EXE1" "$EXE2" "$MOCK" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null
echo "[i6] build mock LLM image (interpretation mode)"; docker build -q -t "$MOCK_IMG" "$HERE/mock-llm" >/dev/null

echo "[i6] start executor 1/2 (alice)"
docker run -d --name "$EXE1" --network "$NET" \
  -e ADMIN_CREDENTIAL="$ADMIN" -e AGENT_PASSPHRASE=windtunnel-pass-alice -e RUN_HOLOCHAIN="${I6_RUN_HOLOCHAIN:-false}" \
  -p 127.0.0.1:${WS1_PORT}:12000 \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges:true --memory 4g --cpus 1.5 --pids-limit 512 \
  "$EXE_IMG" >/dev/null

echo "[i6] start executor 2/2 (bob)"
docker run -d --name "$EXE2" --network "$NET" \
  -e ADMIN_CREDENTIAL="$ADMIN" -e AGENT_PASSPHRASE=windtunnel-pass-bob -e RUN_HOLOCHAIN="${I6_RUN_HOLOCHAIN:-false}" \
  -p 127.0.0.1:${WS2_PORT}:12000 \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges:true --memory 4g --cpus 1.5 --pids-limit 512 \
  "$EXE_IMG" >/dev/null

echo "[i6] start mock LLM"
docker run -d --name "$MOCK" --network "$NET" -e MOCK_LLM_LOG=1 -p 127.0.0.1:${MOCK_PORT}:8080 \
  --security-opt no-new-privileges:true --memory 512m --cpus 1 --pids-limit 256 \
  "$MOCK_IMG" >/dev/null

echo "[i6] wait for both executors + mock to answer"
for PORT in ${WS1_PORT} ${WS2_PORT}; do
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)
    [ "$code" != "000" ] && { echo "[i6] executor on :${PORT} reachable (HTTP $code)"; break; }
    sleep 2
  done
done
for i in $(seq 1 30); do
  curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${MOCK_PORT}/health" 2>/dev/null && { echo "[i6] mock healthy"; break; }
  sleep 1
done

echo "[i6] run driver (two independent auto-processor passes; opt-in best-effort real neighbourhood join)"
cd "$ROOT"
set +e
OUT=$(WS1_HOST=127.0.0.1 WS1_PORT=${WS1_PORT} WS2_HOST=127.0.0.1 WS2_PORT=${WS2_PORT} ADMIN="$ADMIN" \
  MOCK_HOST=127.0.0.1 MOCK_PORT=${MOCK_PORT} MOCK_INTERNAL_URL=http://${MOCK}:8080/v1 \
  I6_ATTEMPT_NEIGHBOURHOOD="${I6_ATTEMPT_NEIGHBOURHOOD:-}" I6_DIFFSYNC_LANGUAGE_HASH="${I6_DIFFSYNC_LANGUAGE_HASH:-}" \
  timeout 300 npx tsx "$HERE/interpretation/i6-autoprocessor-2exec-driver.ts" 2>&1)
RC=$?
set -e
echo "$OUT" | sed 's/^/    /'
if [ $RC -ne 0 ]; then
  echo "[i6] FAIL — driver exited non-zero (see output above)"
  docker logs "$MOCK" 2>&1 | tail -30 | sed 's/^/    mock: /'
  docker logs "$EXE1" 2>&1 | tail -20 | sed 's/^/    alice: /'
  docker logs "$EXE2" 2>&1 | tail -20 | sed 's/^/    bob: /'
  exit 1
fi

if echo "$OUT" | grep -q '\[i6\] SKIP —'; then
  echo "[i6] PASS (partial) — both executors independently run the auto-processor correctly; the shared-neighbourhood claim race skipped honestly (see reason above)"
else
  echo "[i6] PASS (full) — both executors independently run the auto-processor correctly AND the real shared-neighbourhood claim coordinated exactly one processor"
fi
