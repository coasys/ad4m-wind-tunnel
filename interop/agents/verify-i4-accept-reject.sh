#!/usr/bin/env bash
#
# I4 (Accept/Reject) — human resolution of staged interpretation overlays.
#
# Builds three independent bases and exercises all four corners of
# accept/reject: property-scoped accept (an update's staged suggestion
# materializes onto the real value — the accept action explicitly overwrites a
# human's earlier edit), whole-base accept on an already-resolved remainder
# (create-like — overlay cleanly drops away, no value change), whole-base
# reject on an untouched create overlay (this deletes the ENTIRE instance, not
# just the overlay), and property-scoped reject on a diverged update (the
# suggestion drops away, the human's real value survives).
#
# Driven via the raw WS-RPC TS client (no MCP tool for runInterpretation /
# acceptInterpretation / rejectInterpretation). Hardened + host-isolated, full
# teardown. KEEP=1 leaves the pod up. Honest SKIP when the interpretation
# executor image stays absent.
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
EXE_IMG="${INTERP_EXEC_IMAGE:-ad4m-test-interp:latest}"
MOCK_IMG="interp-mockllm"
NET=i4-net
EXE=i4-exec
MOCK=i4-mock
ADMIN=windtunnel-admin
WS_PORT=14631
MOCK_PORT=14632
KEEP="${KEEP:-}"

if ! docker image inspect "$EXE_IMG" >/dev/null 2>&1; then
  echo "[i4] SKIP — no interpretation executor image ($EXE_IMG). Build it from the ad4m-interp #881 branch first."
  exit 0
fi

teardown() { [ -n "$KEEP" ] && { echo "[i4] KEEP set — leaving pod up"; return; }; docker rm -f "$EXE" "$MOCK" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap teardown EXIT

echo "[i4] clean slate"; docker rm -f "$EXE" "$MOCK" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null
echo "[i4] build mock LLM image (interpretation mode)"; docker build -q -t "$MOCK_IMG" "$HERE/mock-llm" >/dev/null

echo "[i4] start executor (single-agent, admin-credential secured, hardened)"
docker run -d --name "$EXE" --network "$NET" \
  -e ADMIN_CREDENTIAL="$ADMIN" -e AGENT_PASSPHRASE=windtunnel-pass -e RUN_HOLOCHAIN=false \
  -p 127.0.0.1:${WS_PORT}:12000 \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges:true --memory 4g --cpus 1.5 --pids-limit 512 \
  "$EXE_IMG" >/dev/null

echo "[i4] start mock LLM"
docker run -d --name "$MOCK" --network "$NET" -e MOCK_LLM_LOG=1 -p 127.0.0.1:${MOCK_PORT}:8080 \
  --security-opt no-new-privileges:true --memory 512m --cpus 1 --pids-limit 256 \
  "$MOCK_IMG" >/dev/null

echo "[i4] wait for executor + mock to answer"
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${WS_PORT}/" 2>/dev/null || echo 000)
  [ "$code" != "000" ] && { echo "[i4] executor reachable (HTTP $code)"; break; }
  sleep 2
done
for i in $(seq 1 30); do
  curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${MOCK_PORT}/health" 2>/dev/null && { echo "[i4] mock healthy"; break; }
  sleep 1
done

echo "[i4] run driver (accept: update->real, create->dropped; reject: create->deleted, update->suggestion dropped)"
cd "$ROOT"
set +e
OUT=$(WS_HOST=127.0.0.1 WS_PORT=${WS_PORT} ADMIN="$ADMIN" MOCK_HOST=127.0.0.1 MOCK_PORT=${MOCK_PORT} MOCK_INTERNAL_URL=http://${MOCK}:8080/v1 \
  timeout 240 npx tsx "$HERE/interpretation/i4-accept-reject-driver.ts" 2>&1)
RC=$?
set -e
echo "$OUT" | sed 's/^/    /'
if [ $RC -ne 0 ]; then
  echo "[i4] FAIL — driver exited non-zero (see output above)"
  docker logs "$MOCK" 2>&1 | tail -30 | sed 's/^/    mock: /'
  docker logs "$EXE" 2>&1 | tail -30 | sed 's/^/    exec: /'
  exit 1
fi

echo "[i4] PASS — accept materializes an update suggestion and cleanly drops a resolved overlay; reject deletes an untouched create wholesale and preserves a human-owned value on an update"
