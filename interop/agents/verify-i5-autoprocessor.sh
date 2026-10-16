#!/usr/bin/env bash
#
# I5 (Auto-processor, single executor) — the executor's neighbourhood
# auto-processor watch loop, not a manual runInterpretation call, does the
# whole pass: gather the transcript, debounce, claim, run the LLM, write the
# typed instance. Registers a processor on a channel-shaped scope query,
# injects a 2-message burst from two distinct authors (`did:key:ana` /
# `did:key:ben`), and asserts (a) exactly one `processed` signal + one typed
# instance, and (b) no double-processing in a grace period afterwards.
#
# Driven via the raw WS-RPC TS client (no MCP tool for addAutoProcessor /
# its `auto-processor-event` signal stream). Hardened + host-isolated, full
# teardown. KEEP=1 leaves the pod up. Honest SKIP when the interpretation
# executor image stays absent.
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
EXE_IMG="${INTERP_EXEC_IMAGE:-ad4m-test-interp:latest}"
MOCK_IMG="interp-mockllm"
NET=i5-net
EXE=i5-exec
MOCK=i5-mock
ADMIN=windtunnel-admin
WS_PORT=14641
MOCK_PORT=14642
KEEP="${KEEP:-}"

if ! docker image inspect "$EXE_IMG" >/dev/null 2>&1; then
  echo "[i5] SKIP — no interpretation executor image ($EXE_IMG). Build it from the ad4m-interp #881 branch first."
  exit 0
fi

teardown() { [ -n "$KEEP" ] && { echo "[i5] KEEP set — leaving pod up"; return; }; docker rm -f "$EXE" "$MOCK" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap teardown EXIT

echo "[i5] clean slate"; docker rm -f "$EXE" "$MOCK" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null
echo "[i5] build mock LLM image (interpretation mode)"; docker build -q -t "$MOCK_IMG" "$HERE/mock-llm" >/dev/null

echo "[i5] start executor (single-agent, admin-credential secured, hardened)"
docker run -d --name "$EXE" --network "$NET" \
  -e ADMIN_CREDENTIAL="$ADMIN" -e AGENT_PASSPHRASE=windtunnel-pass -e RUN_HOLOCHAIN=false \
  -p 127.0.0.1:${WS_PORT}:12000 \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges:true --memory 4g --cpus 1.5 --pids-limit 512 \
  "$EXE_IMG" >/dev/null

echo "[i5] start mock LLM"
docker run -d --name "$MOCK" --network "$NET" -e MOCK_LLM_LOG=1 -p 127.0.0.1:${MOCK_PORT}:8080 \
  --security-opt no-new-privileges:true --memory 512m --cpus 1 --pids-limit 256 \
  "$MOCK_IMG" >/dev/null

echo "[i5] wait for executor + mock to answer"
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${WS_PORT}/" 2>/dev/null || echo 000)
  [ "$code" != "000" ] && { echo "[i5] executor reachable (HTTP $code)"; break; }
  sleep 2
done
for i in $(seq 1 30); do
  curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${MOCK_PORT}/health" 2>/dev/null && { echo "[i5] mock healthy"; break; }
  sleep 1
done

echo "[i5] run driver (addAutoProcessor, inject burst, assert exactly one pass + no double-processing)"
cd "$ROOT"
set +e
OUT=$(WS_HOST=127.0.0.1 WS_PORT=${WS_PORT} ADMIN="$ADMIN" MOCK_HOST=127.0.0.1 MOCK_PORT=${MOCK_PORT} MOCK_INTERNAL_URL=http://${MOCK}:8080/v1 \
  timeout 240 npx tsx "$HERE/interpretation/i5-autoprocessor-driver.ts" 2>&1)
RC=$?
set -e
echo "$OUT" | sed 's/^/    /'
if [ $RC -ne 0 ]; then
  echo "[i5] FAIL — driver exited non-zero (see output above)"
  docker logs "$MOCK" 2>&1 | tail -30 | sed 's/^/    mock: /'
  docker logs "$EXE" 2>&1 | tail -30 | sed 's/^/    exec: /'
  exit 1
fi

echo "[i5] PASS — addAutoProcessor's watch loop ran exactly one batch pass over a 2-author burst; typed instance landed; no double-processing"
