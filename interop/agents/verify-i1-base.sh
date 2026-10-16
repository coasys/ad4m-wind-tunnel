#!/usr/bin/env bash
#
# I1 (Base) — generic-LLM-interpretation end to end, single executor.
#
# Registers a subject class (WtTask) carrying an interpretation hint at the
# class level and on its properties, plus one identity property (`title`).
# Drives `perspective.runInterpretation` over a transcript against a
# deterministic mock LLM (`interop/agents/mock-llm/server.mjs`'s interpretation
# mode), asserts a typed instance landed and reads back correctly, then re-runs
# with a transcript that merely restates the same task — the deterministic
# dedup safety net must drop the duplicate, no new instance created.
#
# Driven via a raw WS-RPC TypeScript client (interop/agents/interpretation/),
# not MCP — `runInterpretation` has no MCP tool. Single-agent, admin-credential
# secured executor (no multi-user/MCP needed). Hardened + host-isolated: private
# network, loopback-only ports, resource limits, full teardown. KEEP=1 leaves
# the pod up for debugging. Honest SKIP when the interpretation executor image
# stays absent (a build outside this repo/PR produces it).
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
EXE_IMG="${INTERP_EXEC_IMAGE:-ad4m-test-interp:latest}"
MOCK_IMG="interp-mockllm"
NET=i1-net
EXE=i1-exec
MOCK=i1-mock
ADMIN=windtunnel-admin
WS_PORT=14601
MOCK_PORT=14602
KEEP="${KEEP:-}"

if ! docker image inspect "$EXE_IMG" >/dev/null 2>&1; then
  echo "[i1] SKIP — no interpretation executor image ($EXE_IMG). Build it from the ad4m-interp #881 branch first."
  exit 0
fi

teardown() { [ -n "$KEEP" ] && { echo "[i1] KEEP set — leaving pod up"; return; }; docker rm -f "$EXE" "$MOCK" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap teardown EXIT

echo "[i1] clean slate"; docker rm -f "$EXE" "$MOCK" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null
echo "[i1] build mock LLM image (interpretation mode)"; docker build -q -t "$MOCK_IMG" "$HERE/mock-llm" >/dev/null

echo "[i1] start executor (single-agent, admin-credential secured, hardened)"
docker run -d --name "$EXE" --network "$NET" \
  -e ADMIN_CREDENTIAL="$ADMIN" -e AGENT_PASSPHRASE=windtunnel-pass -e RUN_HOLOCHAIN=false \
  -p 127.0.0.1:${WS_PORT}:12000 \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges:true --memory 4g --cpus 1.5 --pids-limit 512 \
  "$EXE_IMG" >/dev/null

echo "[i1] start mock LLM"
docker run -d --name "$MOCK" --network "$NET" -e MOCK_LLM_LOG=1 -p 127.0.0.1:${MOCK_PORT}:8080 \
  --security-opt no-new-privileges:true --memory 512m --cpus 1 --pids-limit 256 \
  "$MOCK_IMG" >/dev/null

echo "[i1] wait for executor + mock to answer"
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${WS_PORT}/" 2>/dev/null || echo 000)
  [ "$code" != "000" ] && { echo "[i1] executor reachable (HTTP $code)"; break; }
  sleep 2
done
for i in $(seq 1 30); do
  curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${MOCK_PORT}/health" 2>/dev/null && { echo "[i1] mock healthy"; break; }
  sleep 1
done

echo "[i1] run driver (registers model + WtTask, runInterpretation create, dedup re-run)"
cd "$ROOT"
set +e
OUT=$(WS_HOST=127.0.0.1 WS_PORT=${WS_PORT} ADMIN="$ADMIN" MOCK_HOST=127.0.0.1 MOCK_PORT=${MOCK_PORT} MOCK_INTERNAL_URL=http://${MOCK}:8080/v1 \
  timeout 240 npx tsx "$HERE/interpretation/i1-base-driver.ts" 2>&1)
RC=$?
set -e
echo "$OUT" | sed 's/^/    /'
if [ $RC -ne 0 ]; then
  echo "[i1] FAIL — driver exited non-zero (see output above)"
  docker logs "$MOCK" 2>&1 | tail -30 | sed 's/^/    mock: /'
  docker logs "$EXE" 2>&1 | tail -30 | sed 's/^/    exec: /'
  exit 1
fi

echo "[i1] PASS — WtTask registered with interpretation hints; runInterpretation created a typed instance (readable back); re-run deduplicated with zero new instances"
