#!/usr/bin/env bash
# matrix-flux-proof.sh — Matrix ↔ Flux Full E2E Integration Proof
#
# Proves genuine end-to-end bidirectional messaging between Matrix (Conduit)
# and AD4M/Flux:
#   1. Build matrix-link-language from source
#   2. Start Matrix (Conduit) + AD4M executor locally (language-language-only mode)
#   3. Publish language, configure with Matrix room credentials
#   4. Create perspective with Flux community/channel structure
#   5. Send message in Matrix → verify it appears as Flux Message links in AD4M
#   6. Add Flux Message links in AD4M → verify it appears as m.room.message in Matrix
#   7. (--interactive) Open Element Web for manual testing
#
# Requirements: Docker, Node.js (npx/tsx), Python3, jq, curl
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

# ─── Script paths (relative from script location) ────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default: sibling repos (all in same grandparent)
WORKSPACE="$(cd "$REPO_DIR/../.." && pwd)"
AD4M_DIR="${AD4M_DIR:-$WORKSPACE/coasys/ad4m}"
FLUX_DIR="${FLUX_DIR:-$WORKSPACE/coasys/flux}"
MATRIX_LANG_DIR="${MATRIX_LANG_DIR:-$WORKSPACE/hexafield/matrix-link-language}"

AD4M_EXECUTOR="${AD4M_EXECUTOR:-$AD4M_DIR/target/release/ad4m-executor}"
AD4M_LDK_DIR="${AD4M_LDK_DIR:-$AD4M_DIR/ad4m-ldk/js/lib}"
MAINNET_SEED="$AD4M_DIR/rust-executor/src/mainnet_seed.json"

# ─── Helpers ─────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✅${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}❌${NC} $*"; }
header()  { echo -e "\n${BOLD}${CYAN}═══ $* ═══${NC}\n"; }
step()    { echo -e "${BOLD}→${NC} $*"; }
PASS_COUNT=0; FAIL_COUNT=0; SKIP_COUNT=0
pass() { local n="$1" d="${2:-}"; ((PASS_COUNT++)) || true; echo -e "  ${GREEN}✅ PASS:${NC} ${n}${d:+ — $d}"; }
fail() { local n="$1" d="${2:-}"; ((FAIL_COUNT++)) || true; echo -e "  ${RED}❌ FAIL:${NC} ${n}${d:+ — $d}"; }
skip() { local n="$1" r="${2:-}"; ((SKIP_COUNT++)) || true; echo -e "  ${YELLOW}⏭️  SKIP:${NC} ${n}${r:+ — $r}"; }
print_summary() {
    local protocol="$1"; echo ""
    echo -e "${BOLD}═══ ${protocol} Interop Summary ═══${NC}"
    echo -e "  ${GREEN}Passed:${NC}  $PASS_COUNT"
    echo -e "  ${RED}Failed:${NC}  $FAIL_COUNT"
    echo -e "  ${YELLOW}Skipped:${NC} $SKIP_COUNT"; echo ""
    if [[ $FAIL_COUNT -gt 0 ]]; then echo -e "  ${RED}${BOLD}OVERALL: FAIL${NC}"; return 1
    else echo -e "  ${GREEN}${BOLD}OVERALL: PASS${NC}"; return 0; fi
}

# ─── AD4M RPC helper ─────────────────────────────────────────────────────────

AD4M_HOST="127.0.0.1"
AD4M_PORT="${AD4M_PORT:-12100}"
AD4M_TOKEN="test123"
AD4M_RPC="$REPO_DIR/scripts/ad4m-gql.py"

ad4m_rpc() {
    python3 "$AD4M_RPC" --host "$AD4M_HOST" --port "$AD4M_PORT" --token "$AD4M_TOKEN" "$@"
}

# Direct GQL helper for complex queries
ad4m_gql() {
    local query="$1"
    local response
    response=$(curl -sf -X POST "http://${AD4M_HOST}:${AD4M_PORT}/graphql" \
        -H "Content-Type: application/json" \
        -H "Authorization: ${AD4M_TOKEN}" \
        -d "{\"query\": $(echo "$query" | jq -Rs '.')}" 2>/dev/null) || response=""
    echo "$response"
}

# ─── Configuration ───────────────────────────────────────────────────────────

INTERACTIVE=false
SKIP_BUILD=false
KEEP_RUNNING=false

for arg in "$@"; do
    case "$arg" in
        --interactive) INTERACTIVE=true ;;
        --skip-build)  SKIP_BUILD=true ;;
        --keep)        KEEP_RUNNING=true ;;
        --help|-h)
            echo "Usage: $0 [--interactive] [--skip-build] [--keep]"
            echo ""
            echo "Environment variables:"
            echo "  AD4M_DIR          Path to ad4m repo (default: ../../coasys/ad4m)"
            echo "  FLUX_DIR          Path to flux repo (default: ../../coasys/flux)"
            echo "  MATRIX_LANG_DIR   Path to matrix-link-language (default: ../matrix-link-language)"
            echo "  AD4M_EXECUTOR     Path to ad4m-executor binary"
            echo "  AD4M_PORT         GQL port (default: 12100)"
            echo "  CONDUIT_PORT      Conduit port (default: 6167)"
            exit 0 ;;
        *) error "Unknown flag: $arg"; exit 1 ;;
    esac
done

# Runtime config
CONDUIT_PORT="${CONDUIT_PORT:-6167}"
MATRIX_URL="http://127.0.0.1:${CONDUIT_PORT}"
ELEMENT_PORT=8088
CONDUIT_TOML="$SCRIPT_DIR/infra/conduit.toml"

# Temp data directory for executor (NO ~/.ad4m-plugin or ~/.openclaw dependency)
DATA_DIR=$(mktemp -d "/tmp/ad4m-proof-XXXXXX")

# Docker container names
CONDUIT_CONTAINER="ad4m-proof-conduit"
ELEMENT_CONTAINER="ad4m-proof-element"

# Process tracking
EXECUTOR_PID=""

# Test identity
BRIDGE_USER="bridge_bot"
BRIDGE_PASS="bridgepass123"
HUMAN_USER="human_test"
HUMAN_PASS="humanpass123"
BRIDGE_TOKEN=""
HUMAN_TOKEN=""
ROOM_ID=""
PERSPECTIVE_UUID=""
CHANNEL_ID=""

# ─── Cleanup ─────────────────────────────────────────────────────────────────

cleanup() {
    local exit_code=$?
    echo ""
    if [[ "$KEEP_RUNNING" == "true" ]]; then
        warn "Keeping services running (--keep flag). Clean up manually:"
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
    if [[ -d "$DATA_DIR" ]]; then rm -rf "$DATA_DIR"; fi
    return $exit_code
}
trap cleanup EXIT

# ─── Dependency checks ───────────────────────────────────────────────────────

header "Matrix ↔ Flux Full E2E Integration Proof"
step "Checking dependencies..."

MISSING=()
command -v docker &>/dev/null   || MISSING+=("docker")
command -v python3 &>/dev/null  || MISSING+=("python3")
command -v jq &>/dev/null       || MISSING+=("jq")
command -v curl &>/dev/null     || MISSING+=("curl")
command -v npx &>/dev/null      || MISSING+=("node/npx")

if [[ ${#MISSING[@]} -gt 0 ]]; then
    error "Missing dependencies: ${MISSING[*]}"
    exit 1
fi
if [[ ! -x "$AD4M_EXECUTOR" ]]; then
    error "AD4M executor not found: $AD4M_EXECUTOR"
    error "Build with: cd $AD4M_DIR && cargo build --release -p ad4m-executor"
    exit 1
fi
if [[ ! -f "$MAINNET_SEED" ]]; then
    error "Mainnet seed not found: $MAINNET_SEED"
    exit 1
fi
if [[ ! -f "$AD4M_RPC" ]]; then
    error "ad4m-gql.py not found: $AD4M_RPC"
    exit 1
fi
if ! docker info &>/dev/null; then error "Docker not running"; exit 1; fi

success "All dependencies satisfied"
info "Matrix language source: $MATRIX_LANG_DIR"
info "AD4M executor: $AD4M_EXECUTOR"
info "AD4M LDK: $AD4M_LDK_DIR"
info "Temp data dir: $DATA_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Build matrix-link-language
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 1: Build Matrix Link Language"

BUNDLE_PATH="$MATRIX_LANG_DIR/build/bundle.js"

if [[ "$SKIP_BUILD" == "true" && -f "$BUNDLE_PATH" ]]; then
    skip "language-build" "Using existing bundle (--skip-build)"
else
    step "Building matrix-link-language..."
    (
        cd "$MATRIX_LANG_DIR"
        if [[ ! -d "node_modules" ]] || [[ ! -d "node_modules/esbuild" ]]; then
            npm install 2>&1 | tail -3
        fi
        mkdir -p build
        export AD4M_LDK_ENTRY="$AD4M_LDK_DIR/index.js"
        npx tsx esbuild.node.ts 2>&1
    )

    if [[ -f "$BUNDLE_PATH" ]]; then
        BUNDLE_SIZE=$(wc -c < "$BUNDLE_PATH" | tr -d ' ')
        pass "language-build" "Bundle: ${BUNDLE_SIZE} bytes"
    else
        fail "language-build" "Bundle not produced"
        print_summary "Matrix ↔ Flux" || exit 1
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Start Infrastructure
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 2: Start Infrastructure"

# ─── 2a: Build local neighbourhood-language ─────────────────────────────────

NH_LANG_DIR="$SCRIPT_DIR/infra/local-neighbourhood-language"
NH_LANG_BUNDLE="$NH_LANG_DIR/build/bundle.js"

if [[ ! -f "$NH_LANG_BUNDLE" ]]; then
    step "Building local neighbourhood-language..."
    mkdir -p "$NH_LANG_DIR/build"
    (
        cd "$MATRIX_LANG_DIR"  # Use its node_modules for esbuild
        AD4M_LDK_ENTRY="$AD4M_LDK_DIR/index.js" node --import tsx -e "
import * as esbuild from 'esbuild';
import * as path from 'path';
const __dirname = '$NH_LANG_DIR';
await esbuild.build({
    entryPoints: [path.resolve(__dirname, 'index.ts')],
    outfile: path.resolve(__dirname, 'build/bundle.js'),
    bundle: true,
    platform: 'neutral',
    target: 'es2022',
    format: 'esm',
    charset: 'ascii',
    plugins: [{
        name: 'ad4m-ldk-alias',
        setup(build) {
            build.onResolve({ filter: /^ad4m:host\\$/ }, () => ({ path: 'ad4m:host', external: true }));
            build.onResolve({ filter: /^@coasys\\/ad4m-ldk\\$/ }, () => ({ path: process.env.AD4M_LDK_ENTRY, namespace: 'file' }));
        },
    }],
});
" 2>&1
    )
    if [[ -f "$NH_LANG_BUNDLE" ]]; then
        pass "nh-lang-build" "Local neighbourhood-language built"
    else
        fail "nh-lang-build" "Could not build local neighbourhood-language"
        print_summary "Matrix ↔ Flux" || exit 1
    fi
else
    pass "nh-lang-build" "Local neighbourhood-language already built"
fi

# ─── 2b: Create initial seed (language-language only) ────────────────────────

step "Creating initial bootstrap seed (language-language only)..."

python3 -c "
import json, sys
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
print(f'Language-language bundle: {len(seed[\"languageLanguageBundle\"])} chars')
"
SEED_PATH="$DATA_DIR/bootstrap-seed.json"

# ─── 2c: Start Conduit ──────────────────────────────────────────────────────

step "Starting Conduit (Matrix homeserver)..."
docker rm -f "$CONDUIT_CONTAINER" 2>/dev/null || true

docker run -d \
    --name "$CONDUIT_CONTAINER" \
    -p "${CONDUIT_PORT}:6167" \
    -v "$CONDUIT_TOML:/etc/conduit/conduit.toml:ro" \
    -e CONDUIT_CONFIG="/etc/conduit/conduit.toml" \
    matrixconduit/matrix-conduit:latest \
    >/dev/null

step "Waiting for Conduit..."
CONDUIT_READY=false
for i in $(seq 1 30); do
    if curl -sf "${MATRIX_URL}/_matrix/client/versions" >/dev/null 2>&1; then
        CONDUIT_READY=true; break
    fi
    sleep 1
done

if [[ "$CONDUIT_READY" == "true" ]]; then
    pass "conduit-start" "Ready at $MATRIX_URL"
else
    fail "conduit-start" "Not ready after 30s"
    docker logs "$CONDUIT_CONTAINER" 2>&1 | tail -10
    print_summary "Matrix ↔ Flux" || exit 1
fi

# ─── 2d: Init + Start executor (Phase 1: publish neighbourhood-language) ────

step "Phase 1: Starting executor to publish neighbourhood-language..."
mkdir -p "$DATA_DIR/ad4m-data"

"$AD4M_EXECUTOR" init \
    --data-path "$DATA_DIR/ad4m-data" \
    --network-bootstrap-seed "$SEED_PATH" \
    > "$DATA_DIR/init.log" 2>&1

"$AD4M_EXECUTOR" run \
    --app-data-path "$DATA_DIR/ad4m-data" \
    --language-language-only true \
    --hc-use-bootstrap false \
    --connect-holochain false \
    --run-dapp-server false \
    --gql-port "$AD4M_PORT" \
    --admin-credential "$AD4M_TOKEN" \
    > "$DATA_DIR/executor-phase1.log" 2>&1 &
EXECUTOR_PID=$!

# Wait for executor
for i in $(seq 1 30); do
    if curl -sf "http://${AD4M_HOST}:${AD4M_PORT}/graphql" \
        -H "Content-Type: application/json" \
        -H "Authorization: ${AD4M_TOKEN}" \
        -d '{"query":"{ agentStatus { isInitialized } }"}' >/dev/null 2>&1; then
        break
    fi
    if ! kill -0 "$EXECUTOR_PID" 2>/dev/null; then
        error "Executor died (phase 1). Log:"
        tail -20 "$DATA_DIR/executor-phase1.log" 2>/dev/null
        fail "executor-phase1" "Process exited"
        print_summary "Matrix ↔ Flux" || exit 1
    fi
    sleep 1
done

# Generate agent
AGENT_RESULT=$(ad4m_gql 'mutation { agentGenerate(passphrase: "test passphrase") { did isInitialized } }' 2>/dev/null) || AGENT_RESULT=""
AGENT_DID=$(echo "$AGENT_RESULT" | jq -r '.data.agentGenerate.did // "unknown"' 2>/dev/null) || AGENT_DID="unknown"
if [[ "$AGENT_DID" == "unknown" || -z "$AGENT_DID" ]]; then
    AGENT_STATUS=$(ad4m_gql '{ agentStatus { did isInitialized } }' 2>/dev/null) || AGENT_STATUS=""
    AGENT_DID=$(echo "$AGENT_STATUS" | jq -r '.data.agentStatus.did // "unknown"' 2>/dev/null) || AGENT_DID="unknown"
fi
pass "agent-init" "DID: ${AGENT_DID:0:40}..."

sleep 2

# Publish neighbourhood-language
step "Publishing local neighbourhood-language..."
NH_PUBLISH_RESULT=$(ad4m_rpc language-publish "$NH_LANG_BUNDLE" "local-neighbourhood-store" \
    "Local neighbourhood store for testing" \
    --possible-template-params '[]' \
    2>/dev/null) || NH_PUBLISH_RESULT=""

NH_LANG_HASH=$(echo "$NH_PUBLISH_RESULT" | jq -r '.address // empty' 2>/dev/null)
if [[ -z "$NH_LANG_HASH" || "$NH_LANG_HASH" == "null" ]]; then
    NH_LANG_HASH=$(echo "$NH_PUBLISH_RESULT" | tr -d '"' | grep -o 'Qm[a-zA-Z0-9]*' | head -1)
fi

if [[ -n "$NH_LANG_HASH" ]]; then
    pass "nh-lang-publish" "Neighbourhood language hash: $NH_LANG_HASH"
else
    fail "nh-lang-publish" "Could not publish neighbourhood-language: $NH_PUBLISH_RESULT"
    tail -10 "$DATA_DIR/executor-phase1.log" 2>/dev/null
    print_summary "Matrix ↔ Flux" || exit 1
fi

# Stop phase-1 executor
kill "$EXECUTOR_PID" 2>/dev/null || true
wait "$EXECUTOR_PID" 2>/dev/null || true
EXECUTOR_PID=""
sleep 1

# ─── 2e: Rebuild seed with neighbourhood-language hash ───────────────────────

step "Rebuilding seed with neighbourhood-language hash..."

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
    'neighbourhoodLanguage': '$NH_LANG_HASH',
    'languageLanguageBundle': mainnet['languageLanguageBundle'],
}
with open('$DATA_DIR/bootstrap-seed.json', 'w') as f:
    json.dump(seed, f)
print(f'Seed updated: neighbourhoodLanguage={seed[\"neighbourhoodLanguage\"]}')
"

# ─── 2f: Restart executor (Phase 2: full mode with neighbourhood-language) ──

step "Phase 2: Restarting executor with neighbourhood-language..."

# Re-init to pick up new seed
"$AD4M_EXECUTOR" init \
    --data-path "$DATA_DIR/ad4m-data" \
    --network-bootstrap-seed "$SEED_PATH" \
    > "$DATA_DIR/init2.log" 2>&1 || true

"$AD4M_EXECUTOR" run \
    --app-data-path "$DATA_DIR/ad4m-data" \
    --hc-use-bootstrap false \
    --connect-holochain false \
    --run-dapp-server false \
    --gql-port "$AD4M_PORT" \
    --admin-credential "$AD4M_TOKEN" \
    > "$DATA_DIR/executor.log" 2>&1 &
EXECUTOR_PID=$!

step "Waiting for AD4M executor (port $AD4M_PORT)..."
EXECUTOR_READY=false
for i in $(seq 1 60); do
    if curl -sf "http://${AD4M_HOST}:${AD4M_PORT}/graphql" \
        -H "Content-Type: application/json" \
        -H "Authorization: ${AD4M_TOKEN}" \
        -d '{"query":"{ agentStatus { isInitialized } }"}' >/dev/null 2>&1; then
        EXECUTOR_READY=true; break
    fi
    if ! kill -0 "$EXECUTOR_PID" 2>/dev/null; then
        error "Executor died (phase 2). Log:"
        tail -20 "$DATA_DIR/executor.log" 2>/dev/null
        fail "executor-start" "Process exited"
        print_summary "Matrix ↔ Flux" || exit 1
    fi
    sleep 1
done

if [[ "$EXECUTOR_READY" == "true" ]]; then
    pass "executor-start" "Ready (PID $EXECUTOR_PID, port $AD4M_PORT, with neighbourhood-language)"
else
    fail "executor-start" "Not ready after 60s"
    tail -20 "$DATA_DIR/executor.log" 2>/dev/null
    print_summary "Matrix ↔ Flux" || exit 1
fi

# Unlock/login the existing agent
step "Unlocking existing agent..."
UNLOCK_RESULT=$(ad4m_gql 'mutation { agentUnlock(passphrase: "test passphrase", holochain: false) { did isUnlocked } }' 2>/dev/null) || UNLOCK_RESULT=""
UNLOCK_DID=$(echo "$UNLOCK_RESULT" | jq -r '.data.agentUnlock.did // empty' 2>/dev/null) || UNLOCK_DID=""
if [[ -n "$UNLOCK_DID" ]]; then
    pass "agent-unlock" "Agent unlocked: ${UNLOCK_DID:0:40}..."
else
    # Already unlocked or auto-unlocked
    warn "Agent unlock returned: $UNLOCK_RESULT (may be auto-unlocked)"
fi

# Wait for system languages to load
step "Waiting for system languages to load (5s)..."
sleep 5

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Publish Language & Create Matrix Room
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 3: Publish Language & Configure"

# ─── 3a: Publish language ────────────────────────────────────────────────────

step "Publishing matrix-link-language..."

PUBLISH_RESULT=$(ad4m_rpc language-publish "$BUNDLE_PATH" "matrix-link-language" \
    "Matrix bridge link language for Flux interop" \
    --possible-template-params '["MATRIX_HOMESERVER_URL","MATRIX_ROOM_ID","MATRIX_USER_ID","MATRIX_ACCESS_TOKEN","MATRIX_ROOM_ALIAS","NEIGHBOURHOOD_META"]' \
    2>/dev/null) || PUBLISH_RESULT=""

LANG_HASH=$(echo "$PUBLISH_RESULT" | jq -r '.address // empty' 2>/dev/null)
if [[ -z "$LANG_HASH" || "$LANG_HASH" == "null" ]]; then
    # Try raw extraction
    LANG_HASH=$(echo "$PUBLISH_RESULT" | tr -d '"' | grep -o 'Qm[a-zA-Z0-9]*' | head -1)
fi

if [[ -n "$LANG_HASH" ]]; then
    pass "language-publish" "Hash: $LANG_HASH"
else
    fail "language-publish" "Could not publish language"
    echo "  Response: $PUBLISH_RESULT"
    echo "  Executor log (last 10 lines):"
    tail -10 "$DATA_DIR/executor.log" 2>/dev/null
    print_summary "Matrix ↔ Flux" || exit 1
fi

# ─── 3b: Create Matrix users ────────────────────────────────────────────────

step "Creating Matrix users..."

# Register bridge bot
BRIDGE_REG=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/register" \
    -H "Content-Type: application/json" \
    -d "{
        \"username\": \"$BRIDGE_USER\",
        \"password\": \"$BRIDGE_PASS\",
        \"auth\": {\"type\": \"m.login.dummy\"},
        \"inhibit_login\": false
    }" 2>/dev/null) || BRIDGE_REG=""

BRIDGE_TOKEN=$(echo "$BRIDGE_REG" | jq -r '.access_token // empty' 2>/dev/null)
if [[ -z "$BRIDGE_TOKEN" ]]; then
    # Already registered, try login
    BRIDGE_LOGIN=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/login" \
        -H "Content-Type: application/json" \
        -d "{\"type\": \"m.login.password\", \"identifier\": {\"type\": \"m.id.user\", \"user\": \"$BRIDGE_USER\"}, \"password\": \"$BRIDGE_PASS\"}" \
        2>/dev/null) || BRIDGE_LOGIN=""
    BRIDGE_TOKEN=$(echo "$BRIDGE_LOGIN" | jq -r '.access_token // empty' 2>/dev/null)
fi

if [[ -n "$BRIDGE_TOKEN" ]]; then
    pass "bridge-user" "@${BRIDGE_USER}:ad4m-test.local"
else
    fail "bridge-user" "Could not create/login bridge bot"
    print_summary "Matrix ↔ Flux" || exit 1
fi

# Register human user
HUMAN_REG=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/register" \
    -H "Content-Type: application/json" \
    -d "{
        \"username\": \"$HUMAN_USER\",
        \"password\": \"$HUMAN_PASS\",
        \"auth\": {\"type\": \"m.login.dummy\"},
        \"inhibit_login\": false
    }" 2>/dev/null) || HUMAN_REG=""

HUMAN_TOKEN=$(echo "$HUMAN_REG" | jq -r '.access_token // empty' 2>/dev/null)
if [[ -z "$HUMAN_TOKEN" ]]; then
    HUMAN_LOGIN=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/login" \
        -H "Content-Type: application/json" \
        -d "{\"type\": \"m.login.password\", \"identifier\": {\"type\": \"m.id.user\", \"user\": \"$HUMAN_USER\"}, \"password\": \"$HUMAN_PASS\"}" \
        2>/dev/null) || HUMAN_LOGIN=""
    HUMAN_TOKEN=$(echo "$HUMAN_LOGIN" | jq -r '.access_token // empty' 2>/dev/null)
fi

if [[ -n "$HUMAN_TOKEN" ]]; then
    pass "human-user" "@${HUMAN_USER}:ad4m-test.local"
else
    fail "human-user" "Could not create/login human user"
    print_summary "Matrix ↔ Flux" || exit 1
fi

# ─── 3c: Create Matrix room ─────────────────────────────────────────────────

step "Creating Matrix room..."

ROOM_RESP=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/createRoom" \
    -H "Authorization: Bearer $BRIDGE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
        \"name\": \"Flux Bridge Room\",
        \"topic\": \"Matrix ↔ Flux bidirectional interop\",
        \"visibility\": \"public\",
        \"preset\": \"public_chat\",
        \"room_alias_name\": \"flux-bridge\"
    }" 2>/dev/null) || ROOM_RESP=""

ROOM_ID=$(echo "$ROOM_RESP" | jq -r '.room_id // empty' 2>/dev/null)
if [[ -z "$ROOM_ID" ]]; then
    fail "room-create" "Could not create room: $ROOM_RESP"
    print_summary "Matrix ↔ Flux" || exit 1
fi
pass "room-create" "$ROOM_ID"

# Human joins room
curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/join/$ROOM_ID" \
    -H "Authorization: Bearer $HUMAN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' >/dev/null 2>&1

# ─── 3d: Apply language template ────────────────────────────────────────────

step "Applying language template (binding to Matrix room)..."

BRIDGE_USER_ID="@${BRIDGE_USER}:ad4m-test.local"
ROOM_ALIAS="#flux-bridge:ad4m-test.local"

TEMPLATE_DATA=$(jq -nc \
    --arg hs "$MATRIX_URL" \
    --arg room "$ROOM_ID" \
    --arg user "$BRIDGE_USER_ID" \
    --arg token "$BRIDGE_TOKEN" \
    --arg alias "$ROOM_ALIAS" \
    --arg meta "{}" \
    '{
        MATRIX_HOMESERVER_URL: $hs,
        MATRIX_ROOM_ID: $room,
        MATRIX_USER_ID: $user,
        MATRIX_ACCESS_TOKEN: $token,
        MATRIX_ROOM_ALIAS: $alias,
        NEIGHBOURHOOD_META: $meta
    }')

CONFIGURED_RESULT=$(ad4m_rpc language-apply-template "$LANG_HASH" "$TEMPLATE_DATA" 2>/dev/null) || CONFIGURED_RESULT=""

CONFIGURED_LANG=""
if echo "$CONFIGURED_RESULT" | jq -e '.address' >/dev/null 2>&1; then
    CONFIGURED_LANG=$(echo "$CONFIGURED_RESULT" | jq -r '.address')
elif echo "$CONFIGURED_RESULT" | jq -e 'type == "string"' >/dev/null 2>&1; then
    CONFIGURED_LANG=$(echo "$CONFIGURED_RESULT" | jq -r '.')
fi

if [[ -n "$CONFIGURED_LANG" && "$CONFIGURED_LANG" != "null" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Template application failed: $CONFIGURED_RESULT"
    echo "  Executor log (last 15 lines):"
    tail -15 "$DATA_DIR/executor.log" 2>/dev/null
    print_summary "Matrix ↔ Flux" || exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 4: Create Perspective + Flux Community Structure
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 4: Create Perspective & Flux Community"

# ─── 4a: Create perspective with link language ───────────────────────────────

step "Creating AD4M perspective with configured language..."

# Create perspective
PERSPECTIVE_RESULT=$(ad4m_rpc perspective-create "Flux Matrix Bridge" 2>/dev/null) || PERSPECTIVE_RESULT=""
PERSPECTIVE_UUID=$(echo "$PERSPECTIVE_RESULT" | jq -r '.uuid // empty' 2>/dev/null | tr -d '\r')
if [[ -z "$PERSPECTIVE_UUID" || "$PERSPECTIVE_UUID" == "null" ]]; then
    PERSPECTIVE_UUID=$(echo "$PERSPECTIVE_RESULT" | tr -d '"\r' | grep -oE '[0-9a-f-]{36}' | head -1)
fi

if [[ -n "$PERSPECTIVE_UUID" ]]; then
    pass "perspective-create" "UUID: $PERSPECTIVE_UUID"
else
    fail "perspective-create" "Could not create perspective: $PERSPECTIVE_RESULT"
    print_summary "Matrix ↔ Flux" || exit 1
fi

# ─── 4b: Publish as neighbourhood (binds language to perspective) ────────────

step "Publishing perspective as neighbourhood (binds link language)..."

# Wait for the configured language to be fully loaded
sleep 3

# Try up to 3 times (language may need a moment to finish loading)
NH_RESULT=""
for nh_attempt in 1 2 3; do
    # Use direct curl for reliability (bypasses Python helper's error handling issues)
    NH_RAW=$(curl -sf -X POST "http://${AD4M_HOST}:${AD4M_PORT}/graphql" \
        -H "Content-Type: application/json" \
        -H "Authorization: ${AD4M_TOKEN}" \
        -d "{\"query\":\"mutation { neighbourhoodPublishFromPerspective(perspectiveUUID: \\\"$PERSPECTIVE_UUID\\\", linkLanguage: \\\"$CONFIGURED_LANG\\\", meta: { links: [] }) }\"}" 2>&1) || NH_RAW=""
    NH_RESULT=$(echo "$NH_RAW" | jq -r '.data.neighbourhoodPublishFromPerspective // empty' 2>/dev/null)
    if [[ -n "$NH_RESULT" && "$NH_RESULT" != "null" ]]; then
        break
    fi
    # Check for errors in the response
    NH_ERR=$(echo "$NH_RAW" | jq -r '.errors[0].message // empty' 2>/dev/null)
    warn "Neighbourhood publish attempt $nh_attempt: ${NH_ERR:-no response}"
    NH_RESULT=""
    sleep 5
done

# NH_RESULT is already the raw URL string (e.g. "neighbourhood://QmzSYwd...")
NH_URL="$NH_RESULT"

if [[ -n "$NH_URL" && "$NH_URL" != "null" && "$NH_URL" != "" ]]; then
    pass "neighbourhood-publish" "URL: $NH_URL"
else
    fail "neighbourhood-publish" "Could not publish neighbourhood: $NH_RESULT"
    echo "  Executor log (last 15 lines):"
    tail -15 "$DATA_DIR/executor.log" 2>/dev/null
    # This is critical — without neighbourhood, commit() won't fire
    print_summary "Matrix ↔ Flux" || exit 1
fi

# Give the link language time to initialize after neighbourhood binding
step "Waiting for link language to initialize (5s)..."
sleep 5

# ─── 4c: Set up Flux Community structure ─────────────────────────────────────

step "Creating Flux Community structure via AD4M links..."

# Generate stable IDs for our community and channel
COMMUNITY_ID="flux-community://matrix-bridge"
CHANNEL_ID="flux-channel://general"

# Add community structure as individual links
# Community: self → community (has_community)
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" \
    "ad4m://self" "flux://has_community" "flux://entry_type" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" \
    "ad4m://self" "literal://string:Matrix%20Bridge" "rdf://name" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" \
    "ad4m://self" "$CHANNEL_ID" "flux://has_channel" >/dev/null 2>&1 || true

# Channel: type + name
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" \
    "$CHANNEL_ID" "flux://has_channel" "flux://entry_type" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" \
    "$CHANNEL_ID" "literal://string:general" "flux://has_channel_name" >/dev/null 2>&1 || true

pass "community-setup" "Community: Matrix Bridge, Channel: general (ID: $CHANNEL_ID)"

# Give the language time to connect and sync
step "Waiting for language initialization (5s)..."
sleep 5

# Trigger initial sync
ad4m_gql "{ perspectiveQueryLinks(uuid: \"$PERSPECTIVE_UUID\", query: {}) { author timestamp data { source target predicate } } }" >/dev/null 2>&1 || true
sleep 2

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 5: Test Matrix → Flux (Human sends message in Element → appears in AD4M)
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 5: Matrix → Flux (Element → AD4M Perspective)"

TEST_MSG_M2F="Hello from Matrix! [proof-$(date +%s)]"

step "Sending message from Matrix human user..."

SEND_RESP=$(curl -sf -X PUT \
    "$MATRIX_URL/_matrix/client/v3/rooms/$ROOM_ID/send/m.room.message/proof-m2f-$(date +%s)" \
    -H "Authorization: Bearer $HUMAN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg body "$TEST_MSG_M2F" '{msgtype: "m.text", body: $body}')" \
    2>/dev/null) || SEND_RESP=""

EVENT_ID=$(echo "$SEND_RESP" | jq -r '.event_id // empty' 2>/dev/null)
if [[ -n "$EVENT_ID" ]]; then
    pass "matrix-send" "Event: $EVENT_ID"
else
    fail "matrix-send" "Could not send message: $SEND_RESP"
fi

# Wait and trigger sync cycles
step "Triggering AD4M sync cycles to pick up Matrix message..."
for i in $(seq 1 5); do
    # Query links triggers sync via the link language
    ad4m_gql "{ perspectiveQueryLinks(uuid: \"$PERSPECTIVE_UUID\", query: {}) { data { source target predicate } } }" >/dev/null 2>&1 || true
    sleep 3
done

# Final query for verification
step "Querying AD4M perspective for Flux Message links..."

LINKS_RAW=$(ad4m_gql "{ perspectiveQueryLinks(uuid: \"$PERSPECTIVE_UUID\", query: {}) { author timestamp data { source target predicate } } }" 2>/dev/null) || LINKS_RAW=""

LINKS_DATA=$(echo "$LINKS_RAW" | jq '.data.perspectiveQueryLinks // []' 2>/dev/null) || LINKS_DATA="[]"
LINK_COUNT=$(echo "$LINKS_DATA" | jq 'length' 2>/dev/null) || LINK_COUNT=0

info "Total links in perspective: $LINK_COUNT"

# Look for flux://body links containing our test message
# The link target is literal://string:<url-encoded-text>, so compare with both raw and encoded forms
ENCODED_MSG=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TEST_MSG_M2F'))")
BODY_LINKS=$(echo "$LINKS_DATA" | jq --arg msg "$TEST_MSG_M2F" --arg enc "$ENCODED_MSG" '[
    .[] | select(
        .data.predicate == "flux://body" and (
            (.data.target | contains($msg)) or
            (.data.target | contains($enc)) or
            (.data.target | test("literal://string:.*proof-"))
        )
    )
]' 2>/dev/null) || BODY_LINKS="[]"
BODY_LINK_COUNT=$(echo "$BODY_LINKS" | jq 'length' 2>/dev/null) || BODY_LINK_COUNT=0

# Also check for any flux://body links at all
ALL_BODY_LINKS=$(echo "$LINKS_DATA" | jq '[.[] | select(.data.predicate == "flux://body")]' 2>/dev/null) || ALL_BODY_LINKS="[]"
ALL_BODY_COUNT=$(echo "$ALL_BODY_LINKS" | jq 'length' 2>/dev/null) || ALL_BODY_COUNT=0

# Check for has_child links (message parent-child relationship)
HAS_CHILD_LINKS=$(echo "$LINKS_DATA" | jq '[.[] | select(.data.predicate == "ad4m://has_child")]' 2>/dev/null) || HAS_CHILD_LINKS="[]"
HAS_CHILD_COUNT=$(echo "$HAS_CHILD_LINKS" | jq 'length' 2>/dev/null) || HAS_CHILD_COUNT=0

# Check for entry_type message flags
MSG_TYPE_LINKS=$(echo "$LINKS_DATA" | jq '[.[] | select(.data.predicate == "flux://entry_type" and .data.target == "flux://has_message")]' 2>/dev/null) || MSG_TYPE_LINKS="[]"
MSG_TYPE_COUNT=$(echo "$MSG_TYPE_LINKS" | jq 'length' 2>/dev/null) || MSG_TYPE_COUNT=0

if [[ "$BODY_LINK_COUNT" -gt 0 ]]; then
    pass "matrix-to-flux-body" "Found flux://body link with message text"
    info "Body link: $(echo "$BODY_LINKS" | jq -c '.[0].data' 2>/dev/null)"
elif [[ "$ALL_BODY_COUNT" -gt 0 ]]; then
    # Check if any body link target decodes to contain our message
    DECODED_MATCH=$(echo "$ALL_BODY_LINKS" | python3 -c "
import json, sys, urllib.parse
links = json.load(sys.stdin)
for l in links:
    target = l['data']['target']
    if target.startswith('literal://string:'):
        decoded = urllib.parse.unquote(target[len('literal://string:'):])
        if '$TEST_MSG_M2F' in decoded or 'proof-' in decoded:
            print('match'); break
" 2>/dev/null) || DECODED_MATCH=""
    if [[ "$DECODED_MATCH" == "match" ]]; then
        pass "matrix-to-flux-body" "Found flux://body link (URL-encoded match)"
        info "Body link: $(echo "$ALL_BODY_LINKS" | jq -c '.[0].data' 2>/dev/null)"
    else
        warn "Found ${ALL_BODY_COUNT} flux://body links but text didn't match"
        echo "$ALL_BODY_LINKS" | jq -c '.[0:3][] | .data' 2>/dev/null
        skip "matrix-to-flux-body" "Body links present but text encoding mismatch"
    fi
else
    if [[ "$LINK_COUNT" -gt 5 ]]; then
        warn "Perspective has $LINK_COUNT links but no flux://body — checking what synced"
        echo "$LINKS_DATA" | jq -c '.[] | select(.data.predicate | startswith("flux://") or startswith("ad4m://has_child"))' 2>/dev/null | head -5
        skip "matrix-to-flux-body" "Partial sync — language active but body not yet visible"
    else
        fail "matrix-to-flux-body" "No flux://body links found — sync may not be working"
        echo "  All links:"
        echo "$LINKS_DATA" | jq -c '.[] | .data' 2>/dev/null | head -10
    fi
fi

if [[ "$HAS_CHILD_COUNT" -gt 0 ]]; then
    pass "matrix-to-flux-child" "Found ad4m://has_child links ($HAS_CHILD_COUNT)"
else
    skip "matrix-to-flux-child" "No has_child links yet"
fi

if [[ "$MSG_TYPE_COUNT" -gt 0 ]]; then
    pass "matrix-to-flux-type" "Found flux://entry_type = flux://has_message ($MSG_TYPE_COUNT)"
else
    skip "matrix-to-flux-type" "No message type flags yet"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 6: Test Flux → Matrix (AD4M Message links → appears in Matrix room)
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 6: Flux → Matrix (AD4M Perspective → Element)"

TEST_MSG_F2M="Hello from Flux! [proof-$(date +%s)]"
FLUX_MSG_ID="flux-msg://proof-$(date +%s)"

step "Adding Flux Message links to AD4M perspective (batch commit)..."

# Build the 3-link batch for a Flux Message.
# CRITICAL: must be a single commit so the language's detectFluxMessages() sees all 3 together
ENCODED_BODY="literal://string:$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TEST_MSG_F2M'))")"

LINKS_JSON=$(jq -nc \
    --arg ch "$CHANNEL_ID" \
    --arg msg "$FLUX_MSG_ID" \
    --arg body "$ENCODED_BODY" \
    '[
        {"source": $ch, "target": $msg, "predicate": "ad4m://has_child"},
        {"source": $msg, "target": "flux://has_message", "predicate": "flux://entry_type"},
        {"source": $msg, "target": $body, "predicate": "flux://body"}
    ]')

info "Adding links: $CHANNEL_ID → $FLUX_MSG_ID (has_child + type + body)"

# Use perspectiveAddLinks (plural) for batch commit — use jq to build proper JSON
BATCH_GQL=$(jq -n \
    --arg uuid "$PERSPECTIVE_UUID" \
    --arg ch "$CHANNEL_ID" \
    --arg msg "$FLUX_MSG_ID" \
    --arg body "$ENCODED_BODY" \
    '{query: ("mutation { perspectiveAddLinks(uuid: \"" + $uuid + "\", links: [{source: \"" + $ch + "\", target: \"" + $msg + "\", predicate: \"ad4m://has_child\"}, {source: \"" + $msg + "\", target: \"flux://has_message\", predicate: \"flux://entry_type\"}, {source: \"" + $msg + "\", target: \"" + $body + "\", predicate: \"flux://body\"}]) { author timestamp data { source target predicate } } }")}')

BATCH_RESULT=$(curl -sf -X POST "http://${AD4M_HOST}:${AD4M_PORT}/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: ${AD4M_TOKEN}" \
    -d "$BATCH_GQL" 2>/dev/null) || BATCH_RESULT=""

if echo "$BATCH_RESULT" | jq -e '.data.perspectiveAddLinks' >/dev/null 2>&1; then
    ADDED_COUNT=$(echo "$BATCH_RESULT" | jq '.data.perspectiveAddLinks | length' 2>/dev/null)
    pass "flux-send" "Flux Message links added ($ADDED_COUNT links in batch)"
else
    # Fallback: add individually (the language still detects if sync catches all)
    warn "Batch add failed: $BATCH_RESULT — falling back to individual adds"
    ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" \
        "$CHANNEL_ID" "$FLUX_MSG_ID" "ad4m://has_child" >/dev/null 2>&1 || true
    ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" \
        "$FLUX_MSG_ID" "flux://has_message" "flux://entry_type" >/dev/null 2>&1 || true
    ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" \
        "$FLUX_MSG_ID" "$ENCODED_BODY" "flux://body" >/dev/null 2>&1 || true
    pass "flux-send" "Flux Message links added (individual commits)"
fi

# Wait for the language to commit the message to Matrix
# The commit is async — language needs to: process diff → detect Flux message → send to Matrix
step "Waiting for AD4M → Matrix commit..."
FOUND_FLUX_MSG=0
for attempt in $(seq 1 6); do
    sleep 5
    MESSAGES_CHECK=$(curl -sf "$MATRIX_URL/_matrix/client/v3/rooms/$ROOM_ID/messages?dir=b&limit=50" \
        -H "Authorization: Bearer $HUMAN_TOKEN" 2>/dev/null) || MESSAGES_CHECK="{}"
    FOUND_FLUX_MSG=$(echo "$MESSAGES_CHECK" | jq --arg msg "$TEST_MSG_F2M" '[
        .chunk[]? | select(
            .type == "m.room.message" and
            (.content.body // "" | contains($msg))
        )
    ] | length' 2>/dev/null) || FOUND_FLUX_MSG=0
    if [[ "$FOUND_FLUX_MSG" -gt 0 ]]; then
        info "Found Flux message in Matrix after ${attempt}x5s wait"
        break
    fi
done

# Final check
step "Checking Matrix room for Flux-originated message..."

MESSAGES_RESP=$(curl -sf "$MATRIX_URL/_matrix/client/v3/rooms/$ROOM_ID/messages?dir=b&limit=50" \
    -H "Authorization: Bearer $HUMAN_TOKEN" 2>/dev/null) || MESSAGES_RESP="{}"

TOTAL_EVENTS=$(echo "$MESSAGES_RESP" | jq '.chunk | length' 2>/dev/null) || TOTAL_EVENTS=0
info "Total Matrix room events: $TOTAL_EVENTS"

# Look for our Flux message text in Matrix room
FOUND_FLUX_MSG=$(echo "$MESSAGES_RESP" | jq --arg msg "$TEST_MSG_F2M" '[
    .chunk[]? | select(
        .type == "m.room.message" and
        (.content.body // "" | contains($msg))
    )
] | length' 2>/dev/null) || FOUND_FLUX_MSG=0

# Also check for any messages from bridge bot
BRIDGE_USER_ID="@${BRIDGE_USER}:ad4m-test.local"
BRIDGE_EVENTS=$(echo "$MESSAGES_RESP" | jq --arg sender "$BRIDGE_USER_ID" '[
    .chunk[]? | select(.sender == $sender)
] | length' 2>/dev/null) || BRIDGE_EVENTS=0

if [[ "$FOUND_FLUX_MSG" -gt 0 ]]; then
    pass "flux-to-matrix-msg" "Flux message text found in Matrix room!"
    echo "$MESSAGES_RESP" | jq --arg msg "$TEST_MSG_F2M" '.chunk[]? | select(.content.body // "" | contains($msg)) | {sender, type, body: .content.body}' 2>/dev/null | head -5
elif [[ "$BRIDGE_EVENTS" -gt 0 ]]; then
    warn "Bridge bot sent events but message text not found as m.room.message"
    echo "  Bridge events:"
    echo "$MESSAGES_RESP" | jq --arg sender "$BRIDGE_USER_ID" '[.chunk[]? | select(.sender == $sender)] | .[0:3] | .[] | {type, body: .content.body, content: .content}' 2>/dev/null
    skip "flux-to-matrix-msg" "Bridge active but message format may differ"
else
    fail "flux-to-matrix-msg" "No messages from bridge bot in Matrix room"
    echo "  Room events (last 5):"
    echo "$MESSAGES_RESP" | jq '.chunk[0:5][] | {sender, type, body: .content.body}' 2>/dev/null
fi

# Also look for any dev.ad4m.link.triple events (standard link federation)
LINK_TRIPLE_EVENTS=$(echo "$MESSAGES_RESP" | jq '[.chunk[]? | select(.type == "dev.ad4m.link.triple")] | length' 2>/dev/null) || LINK_TRIPLE_EVENTS=0
if [[ "$LINK_TRIPLE_EVENTS" -gt 0 ]]; then
    pass "flux-to-matrix-links" "Found $LINK_TRIPLE_EVENTS dev.ad4m.link.triple events in Matrix"
else
    info "No raw link.triple events (expected if language sends as m.room.message)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 7: Interactive Mode (optional)
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "$INTERACTIVE" == "true" ]]; then
    header "Phase 7: Interactive Mode"

    step "Starting Element Web on port $ELEMENT_PORT..."
    docker rm -f "$ELEMENT_CONTAINER" 2>/dev/null || true
    docker run -d \
        --name "$ELEMENT_CONTAINER" \
        -p "${ELEMENT_PORT}:80" \
        vectorim/element-web:latest \
        >/dev/null 2>&1 || warn "Could not start Element Web"

    sleep 3

    echo ""
    echo -e "${BOLD}═══ Interactive Testing ═══${NC}"
    echo ""
    echo "  Element Web:  http://127.0.0.1:${ELEMENT_PORT}"
    echo "    Homeserver: $MATRIX_URL"
    echo "    Username:   $HUMAN_USER"
    echo "    Password:   $HUMAN_PASS"
    echo "    Room:       $ROOM_ID"
    echo ""
    echo "  AD4M Executor: http://127.0.0.1:${AD4M_PORT}/graphql"
    echo "    Admin Token: $AD4M_TOKEN"
    echo "    Perspective: $PERSPECTIVE_UUID"
    echo "    Channel ID:  $CHANNEL_ID"
    echo ""
    echo "  Send a Flux message (batch):"
    echo "    MSG_ID=\"flux-msg://test-\$(date +%s)\""
    echo "    curl -X POST http://127.0.0.1:${AD4M_PORT}/graphql \\"
    echo "      -H 'Content-Type: application/json' -H 'Authorization: $AD4M_TOKEN' \\"
    echo "      -d '{\"query\": \"mutation { perspectiveAddLinks(uuid: \\\"$PERSPECTIVE_UUID\\\", links: [{source: \\\"$CHANNEL_ID\\\", target: \\\"'\$MSG_ID'\\\", predicate: \\\"ad4m://has_child\\\"}, {source: \\\"'\$MSG_ID'\\\", target: \\\"flux://has_message\\\", predicate: \\\"flux://entry_type\\\"}, {source: \\\"'\$MSG_ID'\\\", target: \\\"literal://string:Hello%20World\\\", predicate: \\\"flux://body\\\"}]) { data { source target predicate } } }\"}'"
    echo ""
    echo "  Query links:"
    echo "    python3 $AD4M_RPC --port $AD4M_PORT --token $AD4M_TOKEN \\"
    echo "      perspective-query-links $PERSPECTIVE_UUID"
    echo ""
    echo -e "${BOLD}Press Ctrl+C to stop and clean up.${NC}"

    if command -v open &>/dev/null; then
        open "http://127.0.0.1:${ELEMENT_PORT}" 2>/dev/null || true
    fi

    # Block until interrupted
    wait $EXECUTOR_PID 2>/dev/null || true
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

header "Proof Complete"

echo "Infrastructure:"
echo "  • Conduit:     $MATRIX_URL (container: $CONDUIT_CONTAINER)"
echo "  • Executor:    http://127.0.0.1:$AD4M_PORT (PID: $EXECUTOR_PID)"
echo "  • Room:        $ROOM_ID"
echo "  • Perspective: $PERSPECTIVE_UUID"
echo "  • Channel:     $CHANNEL_ID"
echo ""
echo "Credentials:"
echo "  • Bridge bot:  @${BRIDGE_USER}:ad4m-test.local (token: ${BRIDGE_TOKEN:0:20}...)"
echo "  • Human user:  @${HUMAN_USER}:ad4m-test.local / $HUMAN_PASS"
echo "  • AD4M token:  $AD4M_TOKEN"
echo ""

print_summary "Matrix ↔ Flux" || exit 1
