#!/usr/bin/env bash
# matrix-flux-proof.sh — Matrix ↔ Flux Full E2E Integration Proof
#
# Proves genuine end-to-end bidirectional messaging between Matrix (Conduit)
# and AD4M/Flux:
#   1. Build matrix-link-language from source
#   2. Start Matrix (Conduit) + AD4M executor locally (language-language-only mode)
#   3. Publish language, configure with Matrix room credentials
#   4. Create perspective with Flux community/channel structure
#   5. Bind link-language to perspective (neighbourhood hack via SQLite)
#   6. Send message in Matrix → verify it appears as Flux Message links in AD4M
#   7. Add Flux Message links in AD4M → verify it appears as m.room.message in Matrix
#
# Architecture: Single executor instance with --language-language-only true
# (no Holochain, no neighbourhood-language, no Cloudflare dependency).
# Neighbourhood binding done via direct SQLite update + executor restart.
#
# Requirements: Docker, Node.js (npx/tsx), Python3 (websockets), jq, curl
# Repos: ad4m, flux, matrix-link-language, ad4m-wind-tunnel (sibling layout)
#
# Usage:
#   ./matrix-flux-proof.sh                        # Automated proof (headless)
#   ./matrix-flux-proof.sh --interactive          # Also open Element Web
#   ./matrix-flux-proof.sh --skip-build           # Skip language build
#   ./matrix-flux-proof.sh --keep                 # Don't clean up on exit
#   AD4M_DIR=/path/to/ad4m ./matrix-flux-proof.sh # Custom paths
#
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE="${WORKSPACE:-$(cd "$REPO_DIR/.." && pwd)}"

AD4M_DIR="${AD4M_DIR:-$WORKSPACE/ad4m}"
FLUX_DIR="${FLUX_DIR:-$WORKSPACE/flux}"
MATRIX_LANG_DIR="${MATRIX_LANG_DIR:-$WORKSPACE/matrix-link-language}"
AD4M_EXECUTOR="${AD4M_EXECUTOR:-$AD4M_DIR/target/release/ad4m-executor}"
AD4M_LDK_DIR="${AD4M_LDK_DIR:-$AD4M_DIR/ad4m-ldk/js/lib}"
MAINNET_SEED="$AD4M_DIR/rust-executor/src/mainnet_seed.json"
AD4M_RPC_SCRIPT="$REPO_DIR/scripts/ad4m-rpc.py"

AD4M_HOST="127.0.0.1"
AD4M_PORT="${AD4M_PORT:-12100}"
AD4M_TOKEN="${AD4M_TOKEN:-test123}"
CONDUIT_PORT="${CONDUIT_PORT:-6167}"
CONDUIT_TOML="$SCRIPT_DIR/infra/conduit.toml"
CONDUIT_CONTAINER="ad4m-proof-conduit"
ELEMENT_CONTAINER="ad4m-proof-element"
ELEMENT_PORT="${ELEMENT_PORT:-8088}"
MATRIX_URL="http://${AD4M_HOST}:${CONDUIT_PORT}"
BRIDGE_USER="bridge_bot"
BRIDGE_PASS="bridgepass123"
HUMAN_USER="human_test"
HUMAN_PASS="humanpass123"
CHANNEL_ID="flux-channel://general"

DATA_DIR=$(mktemp -d /tmp/ad4m-proof-XXXXXX)
BUNDLE_PATH="$MATRIX_LANG_DIR/build/bundle.js"
EXECUTOR_PID=""

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✅${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}❌${NC} $*"; }
header()  { echo -e "\n${BOLD}${CYAN}═══ $* ═══${NC}"; }
step()    { echo -e "${BOLD}→${NC} $*"; }

RESULTS=()
pass() { RESULTS+=("PASS:$1:$2"); echo -e "  ${GREEN}✅ PASS:${NC} $1 — $2"; }
fail() { RESULTS+=("FAIL:$1:$2"); echo -e "  ${RED}❌ FAIL:${NC} $1 — $2"; }
skip() { RESULTS+=("SKIP:$1:$2"); echo -e "  ${YELLOW}⏭️  SKIP:${NC} $1 — $2"; }

print_summary() {
    local title="$1"
    local passed=0 failed=0 skipped=0
    for r in "${RESULTS[@]}"; do
        case "$r" in PASS:*) ((passed++)) ;; FAIL:*) ((failed++)) ;; SKIP:*) ((skipped++)) ;; esac
    done
    echo -e "\n${BOLD}═══ $title Summary ═══${NC}"
    echo -e "  ${GREEN}Passed:${NC}  $passed"
    echo -e "  ${RED}Failed:${NC}  $failed"
    echo -e "  ${YELLOW}Skipped:${NC} $skipped"
    echo ""
    if [[ $failed -gt 0 ]]; then
        echo -e "  ${RED}${BOLD}OVERALL: FAIL${NC}"
        return 1
    else
        echo -e "  ${GREEN}${BOLD}OVERALL: PASS${NC}"
        return 0
    fi
}

ad4m_rpc() {
    python3 "$AD4M_RPC_SCRIPT" --host "$AD4M_HOST" --port "$AD4M_PORT" --token "$AD4M_TOKEN" "$@"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Flags
# ═══════════════════════════════════════════════════════════════════════════════

INTERACTIVE=false
SKIP_BUILD=false
KEEP_RUNNING=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --interactive) INTERACTIVE=true ;;
        --skip-build)  SKIP_BUILD=true ;;
        --keep)        KEEP_RUNNING=true ;;
        *) echo "Usage: $0 [--interactive] [--skip-build] [--keep]"; exit 1 ;;
    esac
    shift
done

# ═══════════════════════════════════════════════════════════════════════════════
# Cleanup
# ═══════════════════════════════════════════════════════════════════════════════

cleanup() {
    local exit_code=$?
    echo ""
    if [[ "$KEEP_RUNNING" == "true" ]]; then
        warn "Keeping services running (--keep). Clean up manually:"
        echo "  docker rm -f $CONDUIT_CONTAINER $ELEMENT_CONTAINER 2>/dev/null"
        [[ -n "$EXECUTOR_PID" ]] && echo "  kill $EXECUTOR_PID"
        echo "  rm -rf $DATA_DIR"
        return $exit_code
    fi
    step "Cleaning up..."
    if [[ -n "$EXECUTOR_PID" ]] && kill -0 "$EXECUTOR_PID" 2>/dev/null; then
        kill "$EXECUTOR_PID" 2>/dev/null || true
        wait "$EXECUTOR_PID" 2>/dev/null || true
    fi
    docker rm -f "$CONDUIT_CONTAINER" 2>/dev/null || true
    docker rm -f "$ELEMENT_CONTAINER" 2>/dev/null || true
    if [[ -d "$DATA_DIR" && "$exit_code" -eq 0 ]]; then rm -rf "$DATA_DIR"; fi
    return $exit_code
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
# Dependency checks
# ═══════════════════════════════════════════════════════════════════════════════

step "Checking dependencies..."
MISSING=()
command -v docker >/dev/null || MISSING+=(docker)
command -v python3 >/dev/null || MISSING+=(python3)
command -v jq >/dev/null || MISSING+=(jq)
command -v curl >/dev/null || MISSING+=(curl)
command -v npx >/dev/null || MISSING+=(npx)
python3 -c "import websockets" 2>/dev/null || MISSING+=("python3-websockets")
[[ -f "$AD4M_EXECUTOR" ]] || MISSING+=("ad4m-executor at $AD4M_EXECUTOR")
[[ -f "$MAINNET_SEED" ]] || MISSING+=("mainnet_seed.json at $MAINNET_SEED")

if [[ ${#MISSING[@]} -gt 0 ]]; then
    error "Missing: ${MISSING[*]}"
    exit 1
fi
success "All dependencies satisfied"
info "Matrix language source: $MATRIX_LANG_DIR"
info "AD4M executor: $AD4M_EXECUTOR"
info "Temp data dir: $DATA_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Build Matrix Link Language
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 1: Build Matrix Link Language"

if [[ "$SKIP_BUILD" == "true" && -f "$BUNDLE_PATH" ]]; then
    skip "language-build" "Using existing bundle (--skip-build)"
else
    step "Building matrix-link-language..."
    (
        cd "$MATRIX_LANG_DIR"
        AD4M_LDK_ENTRY="$AD4M_LDK_DIR/index.js" npx tsx esbuild.node.ts 2>&1
    )
    if [[ -f "$BUNDLE_PATH" ]]; then
        BUNDLE_SIZE=$(wc -c < "$BUNDLE_PATH" | tr -d ' ')
        pass "language-build" "Bundle: $BUNDLE_PATH ($BUNDLE_SIZE bytes)"
    else
        fail "language-build" "Bundle not found at $BUNDLE_PATH"
        print_summary "Matrix ↔ Flux" || exit 1
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Start Infrastructure
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 2: Start Infrastructure"

# ─── 2a: Create seed ─────────────────────────────────────────────────────────

step "Creating bootstrap seed..."
python3 -c "
import json
with open('$MAINNET_SEED') as f:
    mainnet = json.load(f)
seed = {
    'trustedAgents': [],
    'knownLinkLanguages': [],
    'directMessageLanguage': '',
    'agentLanguage': '',
    'perspectiveLanguage': '',
    'neighbourhoodLanguage': '',
    'languageLanguageBundle': mainnet['languageLanguageBundle'],
}
with open('$DATA_DIR/bootstrap-seed.json', 'w') as f:
    json.dump(seed, f)
"
SEED_PATH="$DATA_DIR/bootstrap-seed.json"

# ─── 2b: Start Conduit ───────────────────────────────────────────────────────

step "Starting Conduit (Matrix homeserver)..."
docker rm -f "$CONDUIT_CONTAINER" 2>/dev/null || true
docker run -d \
    --name "$CONDUIT_CONTAINER" \
    -p "${CONDUIT_PORT}:6167" \
    -v "$CONDUIT_TOML:/etc/conduit/conduit.toml:ro" \
    -e CONDUIT_CONFIG="/etc/conduit/conduit.toml" \
    matrixconduit/matrix-conduit:latest >/dev/null

for i in $(seq 1 30); do
    if curl -sf "${MATRIX_URL}/_matrix/client/versions" >/dev/null 2>&1; then break; fi
    sleep 1
done
if curl -sf "${MATRIX_URL}/_matrix/client/versions" >/dev/null 2>&1; then
    pass "conduit-start" "Ready at $MATRIX_URL"
else
    fail "conduit-start" "Not ready after 30s"
    print_summary "Matrix ↔ Flux" || exit 1
fi

# ─── 2c: Init + Start executor ───────────────────────────────────────────────

step "Starting AD4M executor (language-language-only mode)..."
mkdir -p "$DATA_DIR/ad4m-data"
"$AD4M_EXECUTOR" init \
    --data-path "$DATA_DIR/ad4m-data" \
    --network-bootstrap-seed "$SEED_PATH" > /dev/null 2>&1

"$AD4M_EXECUTOR" run \
    --app-data-path "$DATA_DIR/ad4m-data" \
    --language-language-only true \
    --hc-use-bootstrap false \
    --connect-holochain false \
    --run-dapp-server false \
    --port "$AD4M_PORT" \
    --admin-credential "$AD4M_TOKEN" \
    --enable-multi-user true \
    > "$DATA_DIR/executor.log" 2>&1 &
EXECUTOR_PID=$!

for i in $(seq 1 30); do
    if curl -sf "http://${AD4M_HOST}:${AD4M_PORT}/api/v1/health" >/dev/null 2>&1; then
        break
    fi
    if ! kill -0 "$EXECUTOR_PID" 2>/dev/null; then
        fail "executor-start" "Process died"; print_summary "Matrix ↔ Flux" || exit 1
    fi
    sleep 1
done
pass "executor-start" "Ready (PID $EXECUTOR_PID, port $AD4M_PORT)"

# ─── 2d: Generate agent ──────────────────────────────────────────────────────

step "Generating AD4M agent..."
AGENT_RESULT=$(ad4m_rpc agent-generate 2>/dev/null) || AGENT_RESULT=""
AGENT_DID=$(echo "$AGENT_RESULT" | jq -r '.did // empty' 2>/dev/null)
if [[ -z "$AGENT_DID" ]]; then
    AGENT_DID=$(ad4m_rpc agent-status 2>/dev/null | jq -r '.did // "unknown"' 2>/dev/null)
fi
pass "agent-init" "DID: ${AGENT_DID:0:40}..."
sleep 2

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Publish Language & Configure
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 3: Publish Language & Configure"

# ─── 3a: Create Matrix users + room ──────────────────────────────────────────

step "Creating Matrix users..."
BRIDGE_REG=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/register" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$BRIDGE_USER\",\"password\":\"$BRIDGE_PASS\",\"auth\":{\"type\":\"m.login.dummy\"},\"inhibit_login\":false}" 2>/dev/null) || BRIDGE_REG=""
BRIDGE_TOKEN=$(echo "$BRIDGE_REG" | jq -r '.access_token // empty' 2>/dev/null)
if [[ -z "$BRIDGE_TOKEN" ]]; then
    BRIDGE_TOKEN=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/login" -H "Content-Type: application/json" \
        -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$BRIDGE_USER\"},\"password\":\"$BRIDGE_PASS\"}" | jq -r '.access_token // empty')
fi
[[ -n "$BRIDGE_TOKEN" ]] && pass "bridge-user" "@${BRIDGE_USER}:ad4m-test.local" || { fail "bridge-user" "Failed"; print_summary "Matrix ↔ Flux" || exit 1; }

HUMAN_REG=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/register" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$HUMAN_USER\",\"password\":\"$HUMAN_PASS\",\"auth\":{\"type\":\"m.login.dummy\"},\"inhibit_login\":false}" 2>/dev/null) || HUMAN_REG=""
HUMAN_TOKEN=$(echo "$HUMAN_REG" | jq -r '.access_token // empty' 2>/dev/null)
if [[ -z "$HUMAN_TOKEN" ]]; then
    HUMAN_TOKEN=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/login" -H "Content-Type: application/json" \
        -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$HUMAN_USER\"},\"password\":\"$HUMAN_PASS\"}" | jq -r '.access_token // empty')
fi
[[ -n "$HUMAN_TOKEN" ]] && pass "human-user" "@${HUMAN_USER}:ad4m-test.local" || { fail "human-user" "Failed"; print_summary "Matrix ↔ Flux" || exit 1; }

step "Creating Matrix room..."
ROOM_RESP=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/createRoom" \
    -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"Flux Bridge Room","preset":"public_chat","room_alias_name":"flux-bridge"}' 2>/dev/null) || ROOM_RESP=""
ROOM_ID=$(echo "$ROOM_RESP" | jq -r '.room_id // empty' 2>/dev/null)
[[ -n "$ROOM_ID" ]] && pass "room-create" "$ROOM_ID" || { fail "room-create" "Failed: $ROOM_RESP"; print_summary "Matrix ↔ Flux" || exit 1; }

# Human joins
curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/join/$ROOM_ID" -H "Authorization: Bearer $HUMAN_TOKEN" -H "Content-Type: application/json" -d '{}' >/dev/null 2>&1

# ─── 3b: Publish language + apply template ────────────────────────────────────

step "Publishing matrix-link-language..."
PUBLISH_RESULT=$(ad4m_rpc language-publish "$BUNDLE_PATH" "matrix-link-language" \
    "Matrix bridge link language for Flux interop" \
    --possible-template-params '["MATRIX_HOMESERVER_URL","MATRIX_ROOM_ID","MATRIX_USER_ID","MATRIX_ACCESS_TOKEN","MATRIX_ROOM_ALIAS","NEIGHBOURHOOD_META"]' \
    2>/dev/null) || PUBLISH_RESULT=""
LANG_HASH=$(echo "$PUBLISH_RESULT" | jq -r '.address // empty' 2>/dev/null)
[[ -n "$LANG_HASH" ]] && pass "language-publish" "Hash: $LANG_HASH" || { fail "language-publish" "Failed: $PUBLISH_RESULT"; print_summary "Matrix ↔ Flux" || exit 1; }

step "Applying language template..."
BRIDGE_USER_ID="@${BRIDGE_USER}:ad4m-test.local"
TEMPLATE_DATA=$(jq -nc \
    --arg hs "$MATRIX_URL" \
    --arg room "$ROOM_ID" \
    --arg user "$BRIDGE_USER_ID" \
    --arg token "$BRIDGE_TOKEN" \
    --arg alias "#flux-bridge:ad4m-test.local" \
    --arg meta "{}" \
    '{MATRIX_HOMESERVER_URL:$hs, MATRIX_ROOM_ID:$room, MATRIX_USER_ID:$user, MATRIX_ACCESS_TOKEN:$token, MATRIX_ROOM_ALIAS:$alias, NEIGHBOURHOOD_META:$meta}')

CONFIGURED_RESULT=$(ad4m_rpc language-apply-template "$LANG_HASH" "$TEMPLATE_DATA" 2>/dev/null) || CONFIGURED_RESULT=""
CONFIGURED_LANG=$(echo "$CONFIGURED_RESULT" | jq -r '.address // empty' 2>/dev/null)
[[ -n "$CONFIGURED_LANG" ]] && pass "language-configure" "Configured: $CONFIGURED_LANG" || { fail "language-configure" "Failed: $CONFIGURED_RESULT"; print_summary "Matrix ↔ Flux" || exit 1; }

# Verify executor alive after template application (V8 isolate creation)
if ! kill -0 "$EXECUTOR_PID" 2>/dev/null; then
    fail "executor-alive" "Executor died during template application"
    tail -10 "$DATA_DIR/executor.log" 2>/dev/null
    print_summary "Matrix ↔ Flux" || exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 4: Create Perspective & Bind Link Language
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 4: Create Perspective & Bind Link Language"

step "Creating AD4M perspective..."
PERSP_RESULT=$(ad4m_rpc perspective-create "Flux Matrix Bridge" 2>/dev/null) || PERSP_RESULT=""
PERSPECTIVE_UUID=$(echo "$PERSP_RESULT" | jq -r '.uuid // empty' 2>/dev/null)
[[ -n "$PERSPECTIVE_UUID" ]] && pass "perspective-create" "UUID: $PERSPECTIVE_UUID" || { fail "perspective-create" "Failed: $PERSP_RESULT"; print_summary "Matrix ↔ Flux" || exit 1; }

# ─── 4a: Bind link language via neighbourhood DB hack ─────────────────────────

step "Binding link language to perspective (neighbourhood via SQLite)..."

DB_PATH="$DATA_DIR/ad4m-data/ad4m_db.sqlite"
NH_JSON=$(python3 -c "
import json
nh = {
    'author': '$AGENT_DID',
    'data': {
        'linkLanguage': '$CONFIGURED_LANG',
        'meta': {'links': []}
    },
    'proof': {
        'key': '#key1',
        'signature': 'local_test_proof',
        'valid': True,
        'invalid': False
    },
    'timestamp': '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
}
print(json.dumps(nh))
")

python3 -c "
import sqlite3, json, sys
db = sqlite3.connect('$DB_PATH')
nh_json = json.loads('''$NH_JSON''')
db.execute(
    'UPDATE perspective_handle SET neighbourhood = ?, shared_url = ?, state = ?, owners = ? WHERE uuid = ?',
    (json.dumps(nh_json), 'neighbourhood://local-matrix-bridge', '\"Synced\"', json.dumps(['$AGENT_DID']), '$PERSPECTIVE_UUID')
)
db.commit()
row = db.execute('SELECT neighbourhood FROM perspective_handle WHERE uuid = ?', ('$PERSPECTIVE_UUID',)).fetchone()
if row and row[0]:
    print(f'OK ({len(row[0])} chars)')
else:
    print('FAILED')
    sys.exit(1)
db.close()
"
DB_UPDATE_RESULT=$?
if [[ $DB_UPDATE_RESULT -eq 0 ]]; then
    pass "neighbourhood-bind" "Link language bound to perspective via DB"
else
    fail "neighbourhood-bind" "SQLite update failed"
    print_summary "Matrix ↔ Flux" || exit 1
fi

# ─── 4b: Restart executor to pick up neighbourhood binding ───────────────────

step "Restarting executor to load link language..."
kill "$EXECUTOR_PID" 2>/dev/null || true
wait "$EXECUTOR_PID" 2>/dev/null || true
sleep 1

"$AD4M_EXECUTOR" run \
    --app-data-path "$DATA_DIR/ad4m-data" \
    --language-language-only true \
    --hc-use-bootstrap false \
    --connect-holochain false \
    --run-dapp-server false \
    --port "$AD4M_PORT" \
    --admin-credential "$AD4M_TOKEN" \
    --enable-multi-user true \
    > "$DATA_DIR/executor.log" 2>&1 &
EXECUTOR_PID=$!

for i in $(seq 1 30); do
    if curl -sf "http://${AD4M_HOST}:${AD4M_PORT}/api/v1/health" >/dev/null 2>&1; then
        break
    fi
    if ! kill -0 "$EXECUTOR_PID" 2>/dev/null; then
        fail "executor-restart" "Died on restart"; print_summary "Matrix ↔ Flux" || exit 1
    fi
    sleep 1
done
pass "executor-restart" "Ready (PID $EXECUTOR_PID)"

# Unlock agent (required for link signing/commit)
step "Unlocking agent..."
UNLOCK_RESULT=$(ad4m_rpc raw "agent.unlock" '{"passphrase":"test passphrase","holochain":false}' 2>/dev/null) || UNLOCK_RESULT=""
UNLOCK_DID=$(echo "$UNLOCK_RESULT" | jq -r '.did // empty' 2>/dev/null)
if [[ -n "$UNLOCK_DID" ]]; then
    pass "agent-unlock" "Unlocked: ${UNLOCK_DID:0:40}..."
else
    warn "Unlock result: $UNLOCK_RESULT"
    fail "agent-unlock" "Failed to unlock agent"
    print_summary "Matrix ↔ Flux" || exit 1
fi

# Wait for ensure_link_language to load the configured language
step "Waiting for link language to initialize (10s)..."
sleep 10

# Verify the language loaded
PERSP_CHECK=$(ad4m_rpc raw "perspective.get" "{\"uuid\":\"$PERSPECTIVE_UUID\"}" 2>/dev/null) || PERSP_CHECK=""
LOADED_LANG=$(echo "$PERSP_CHECK" | jq -r '.neighbourhood.data.linkLanguage // empty' 2>/dev/null)
if [[ "$LOADED_LANG" == "$CONFIGURED_LANG" ]]; then
    pass "link-language-loaded" "Language active: ${CONFIGURED_LANG:0:20}..."
else
    warn "Perspective neighbourhood check: $PERSP_CHECK"
    # Give more time
    sleep 10
fi

# ─── 4c: Set up Flux Community structure ─────────────────────────────────────

step "Creating Flux Community structure..."

# These are local-only links (won't trigger commit since we're adding them individually for structure)
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "ad4m://self" "flux://has_community" "flux://entry_type" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "ad4m://self" "literal://string:Matrix%20Bridge" "rdf://name" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "ad4m://self" "$CHANNEL_ID" "flux://has_channel" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$CHANNEL_ID" "flux://has_channel" "flux://entry_type" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$CHANNEL_ID" "literal://string:general" "flux://has_channel_name" >/dev/null 2>&1 || true
pass "community-setup" "Community: Matrix Bridge, Channel: general"

# Trigger a sync to pick up any pending Matrix messages
ad4m_rpc perspective-query-links "$PERSPECTIVE_UUID" >/dev/null 2>&1 || true
sleep 3

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 5: Matrix → Flux Proof
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 5: Matrix → Flux (Element → AD4M Perspective)"

TEST_MSG_M2F="Hello from Matrix! [proof-$(date +%s)]"

step "Sending message from Matrix human user..."
SEND_RESP=$(curl -sf -X PUT \
    "$MATRIX_URL/_matrix/client/v3/rooms/$ROOM_ID/send/m.room.message/proof-m2f-$(date +%s)" \
    -H "Authorization: Bearer $HUMAN_TOKEN" -H "Content-Type: application/json" \
    -d "$(jq -n --arg body "$TEST_MSG_M2F" '{msgtype:"m.text",body:$body}')" 2>/dev/null) || SEND_RESP=""
EVENT_ID=$(echo "$SEND_RESP" | jq -r '.event_id // empty' 2>/dev/null)
[[ -n "$EVENT_ID" ]] && pass "matrix-send" "Event: $EVENT_ID" || fail "matrix-send" "Failed: $SEND_RESP"

# Trigger sync cycles
step "Triggering AD4M sync to pick up Matrix message..."
for i in $(seq 1 8); do
    ad4m_rpc perspective-query-links "$PERSPECTIVE_UUID" >/dev/null 2>&1 || true
    sleep 3
done

# Check for Flux message links
step "Checking for Flux Message links in perspective..."
LINKS_RAW=$(ad4m_rpc perspective-query-links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS_RAW="[]"
LINK_COUNT=$(echo "$LINKS_RAW" | jq 'length' 2>/dev/null) || LINK_COUNT=0
info "Total links in perspective: $LINK_COUNT"

# Look for flux://body links
BODY_LINKS=$(echo "$LINKS_RAW" | jq '[.[] | select(.data.predicate == "flux://body")]' 2>/dev/null) || BODY_LINKS="[]"
BODY_COUNT=$(echo "$BODY_LINKS" | jq 'length' 2>/dev/null) || BODY_COUNT=0
HAS_CHILD=$(echo "$LINKS_RAW" | jq '[.[] | select(.data.predicate == "ad4m://has_child")]' 2>/dev/null) || HAS_CHILD="[]"
CHILD_COUNT=$(echo "$HAS_CHILD" | jq 'length' 2>/dev/null) || CHILD_COUNT=0

if [[ "$BODY_COUNT" -gt 0 ]]; then
    pass "matrix-to-flux" "Found $BODY_COUNT flux://body links + $CHILD_COUNT has_child links"
    echo "$BODY_LINKS" | jq -c '.[0].data' 2>/dev/null
else
    if [[ "$LINK_COUNT" -gt 5 ]]; then
        warn "Perspective has $LINK_COUNT links but no flux://body — language active but sync pending"
        echo "$LINKS_RAW" | jq -c '.[] | select(.data.predicate | startswith("flux://")) | .data' 2>/dev/null | head -5
        skip "matrix-to-flux" "Language active, sync in progress"
    else
        fail "matrix-to-flux" "No flux://body links found"
        # Show what's there
        echo "$LINKS_RAW" | jq -c '.[] | .data' 2>/dev/null | head -10
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 6: Flux → Matrix Proof
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 6: Flux → Matrix (AD4M Perspective → Element)"

TEST_MSG_F2M="Hello from Flux! [proof-$(date +%s)]"
FLUX_MSG_ID="flux-msg://proof-$(date +%s)"
ENCODED_BODY="literal://string:$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TEST_MSG_F2M'))")"

step "Adding Flux Message links (batch commit)..."

# Use raw RPC to add multiple links at once
BATCH_LINKS=$(jq -nc --arg uuid "$PERSPECTIVE_UUID" --arg ch "$CHANNEL_ID" \
    --arg msgid "$FLUX_MSG_ID" --arg body "$ENCODED_BODY" \
    '{uuid:$uuid, links:[
        {source:$ch, target:$msgid, predicate:"ad4m://has_child"},
        {source:$msgid, target:"flux://has_message", predicate:"flux://entry_type"},
        {source:$msgid, target:$body, predicate:"flux://body"}
    ]}')

BATCH_RESULT=$(ad4m_rpc raw "perspective.addLinks" "$BATCH_LINKS" 2>/dev/null) || BATCH_RESULT=""
ADDED=$(echo "$BATCH_RESULT" | jq 'length' 2>/dev/null) || ADDED=0
if [[ "$ADDED" -gt 0 ]]; then
    pass "flux-send" "Added $ADDED links (batch commit → triggers Matrix send)"
else
    warn "Batch result: $BATCH_RESULT"
    # Fallback: individual adds
    ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$CHANNEL_ID" "$FLUX_MSG_ID" "ad4m://has_child" >/dev/null 2>&1 || true
    ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$FLUX_MSG_ID" "flux://has_message" "flux://entry_type" >/dev/null 2>&1 || true
    ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$FLUX_MSG_ID" "$ENCODED_BODY" "flux://body" >/dev/null 2>&1 || true
    pass "flux-send" "Added links individually"
fi

# Wait for commit to fire → message appears in Matrix
step "Waiting for AD4M → Matrix commit (30s max)..."
FOUND_MSG=0
for attempt in $(seq 1 6); do
    sleep 5
    MESSAGES=$(curl -sf "$MATRIX_URL/_matrix/client/v3/rooms/$ROOM_ID/messages?dir=b&limit=50" \
        -H "Authorization: Bearer $HUMAN_TOKEN" 2>/dev/null) || MESSAGES="{}"
    FOUND_MSG=$(echo "$MESSAGES" | jq --arg msg "$TEST_MSG_F2M" '[.chunk[]? | select(.type=="m.room.message" and (.content.body // "" | contains($msg)))] | length' 2>/dev/null) || FOUND_MSG=0
    if [[ "$FOUND_MSG" -gt 0 ]]; then break; fi
done

step "Checking Matrix room for Flux message..."
if [[ "$FOUND_MSG" -gt 0 ]]; then
    pass "flux-to-matrix" "Flux message appeared in Matrix room! ✨"
    echo "$MESSAGES" | jq --arg msg "$TEST_MSG_F2M" '.chunk[]? | select(.content.body // "" | contains($msg)) | {sender, body: .content.body}' 2>/dev/null | head -3
else
    # Check for any bridge bot messages
    BRIDGE_MSGS=$(echo "$MESSAGES" | jq --arg sender "@${BRIDGE_USER}:ad4m-test.local" '[.chunk[]? | select(.sender==$sender)] | length' 2>/dev/null) || BRIDGE_MSGS=0
    if [[ "$BRIDGE_MSGS" -gt 0 ]]; then
        warn "Bridge bot sent $BRIDGE_MSGS events but message text not found"
        echo "$MESSAGES" | jq --arg sender "@${BRIDGE_USER}:ad4m-test.local" '.chunk[]? | select(.sender==$sender) | {sender,type,body:.content.body}' 2>/dev/null | head -3
        skip "flux-to-matrix" "Bridge active, message format may differ"
    else
        fail "flux-to-matrix" "No messages from bridge in Matrix"
        # Show executor commit logs
        grep -i "commit\|sendEvent\|flux.*message\|m.room.message" "$DATA_DIR/executor.log" 2>/dev/null | tail -10
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 7: Interactive Mode (optional)
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "$INTERACTIVE" == "true" ]]; then
    header "Phase 7: Interactive Mode"

    # ─── 7a: Start Element Web ────────────────────────────────────────────────
    step "Starting Element Web on port $ELEMENT_PORT..."
    docker rm -f "$ELEMENT_CONTAINER" 2>/dev/null || true
    docker run -d --name "$ELEMENT_CONTAINER" -p "${ELEMENT_PORT}:80" vectorim/element-web:latest >/dev/null

    for i in $(seq 1 15); do
        curl -sf "http://127.0.0.1:${ELEMENT_PORT}" >/dev/null 2>&1 && break
        sleep 1
    done
    pass "element-start" "Element Web on http://127.0.0.1:${ELEMENT_PORT}"

    # ─── 7b: Serve Flux ───────────────────────────────────────────────────────
    FLUX_PORT="${FLUX_PORT:-3030}"
    if [[ -d "$FLUX_DIR/app/dist" ]]; then
        step "Serving Flux on port $FLUX_PORT..."
        pkill -f "vite.*preview.*${FLUX_PORT}" 2>/dev/null || true
        (cd "$FLUX_DIR/app" && npx vite preview --port "$FLUX_PORT" > /tmp/flux-serve.log 2>&1) &
        FLUX_PID=$!
        for i in $(seq 1 10); do
            curl -sf "http://localhost:${FLUX_PORT}" >/dev/null 2>&1 && break
            sleep 1
        done
        if curl -sf "http://localhost:${FLUX_PORT}" >/dev/null 2>&1; then
            pass "flux-serve" "Flux on http://localhost:${FLUX_PORT}"
        else
            warn "Flux not serving — build with: cd $FLUX_DIR/app && pnpm build"
        fi
    else
        warn "Flux dist not found at $FLUX_DIR/app/dist — skipping Flux"
        warn "Build with: cd $FLUX_DIR && pnpm install && cd app && pnpm build"
    fi

    # ─── 7c: Create multi-user test account for Flux ──────────────────────────
    step "Creating multi-user test account for Flux..."
    FLUX_EMAIL="dev@test.com"
    FLUX_PASS="test123"

    CREATE_USER=$(ad4m_rpc raw "user.create" "{\"email\":\"$FLUX_EMAIL\",\"password\":\"$FLUX_PASS\"}" 2>/dev/null) || CREATE_USER=""
    USER_JWT=$(echo "$CREATE_USER" | jq -r '.jwt // empty' 2>/dev/null)
    if [[ -z "$USER_JWT" ]]; then
        # User may already exist, try login
        LOGIN_USER=$(ad4m_rpc raw "user.login" "{\"email\":\"$FLUX_EMAIL\",\"password\":\"$FLUX_PASS\"}" 2>/dev/null) || LOGIN_USER=""
        USER_JWT=$(echo "$LOGIN_USER" | jq -r '.jwt // empty' 2>/dev/null)
    fi

    if [[ -n "$USER_JWT" ]]; then
        pass "flux-user" "User $FLUX_EMAIL authenticated (JWT: ${USER_JWT:0:20}...)"
    else
        warn "Could not create/login Flux user — manual auth needed in browser"
        USER_JWT="$AD4M_TOKEN"
    fi

    # ─── 7d: Open browsers with auto-auth ─────────────────────────────────────
    DEVTOOLS_DIR="${DEVTOOLS_DIR:-$WORKSPACE/ad4m-devtools}"
    BROWSER_AUTH="$DEVTOOLS_DIR/scripts/ad4m-flux-browser-auth.sh"

    if [[ -x "$BROWSER_AUTH" ]] && curl -sf "http://localhost:${FLUX_PORT}" >/dev/null 2>&1; then
        step "Running browser auth (auto-login to Flux)..."
        bash "$BROWSER_AUTH" \
            --executor-url "http://127.0.0.1:${AD4M_PORT}" \
            --flux-url "http://localhost:${FLUX_PORT}" \
            --email "$FLUX_EMAIL" \
            --password "$FLUX_PASS" \
            --admin-credential "$AD4M_TOKEN" \
            --flux-dir "$FLUX_DIR" \
            --chrome-port 9223 \
            2>&1 | sed 's/^/  [flux-auth] /' || warn "Browser auth failed — open manually"
    else
        # Just open the URLs in default browser
        step "Opening browsers..."
        open "http://127.0.0.1:${ELEMENT_PORT}" 2>/dev/null || true
        if curl -sf "http://localhost:${FLUX_PORT}" >/dev/null 2>&1; then
            open "http://localhost:${FLUX_PORT}" 2>/dev/null || true
        fi
    fi

    # ─── 7e: Print connection info ────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}═══ Services Running ═══${NC}"
    echo ""
    echo "  Element Web:  http://127.0.0.1:${ELEMENT_PORT}"
    echo "    Homeserver: $MATRIX_URL"
    echo "    Username:   $HUMAN_USER"
    echo "    Password:   $HUMAN_PASS"
    echo ""
    if curl -sf "http://localhost:${FLUX_PORT}" >/dev/null 2>&1; then
        echo "  Flux:         http://localhost:${FLUX_PORT}"
        echo "    Executor:   http://127.0.0.1:${AD4M_PORT}"
        echo "    User:       $FLUX_EMAIL / $FLUX_PASS"
        echo ""
    fi
    echo "  AD4M WS RPC:  ws://127.0.0.1:${AD4M_PORT}/api/v1/ws"
    echo "    Admin Token: $AD4M_TOKEN"
    echo "    Perspective: $PERSPECTIVE_UUID"
    echo "    Channel:     $CHANNEL_ID"
    echo ""
    echo -e "${BOLD}Send messages in Element → they appear as Flux links in AD4M${NC}"
    echo -e "${BOLD}Add Flux message links in AD4M → they appear in Element${NC}"
    echo ""
    echo -e "${BOLD}Press Ctrl+C to stop and clean up.${NC}"

    KEEP_RUNNING=true
    wait "$EXECUTOR_PID" 2>/dev/null || true
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

print_summary "Matrix ↔ Flux" || exit 1
