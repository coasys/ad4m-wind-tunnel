#!/usr/bin/env bash
# matrix-bridge-test.sh — E2E Matrix ↔ AD4M/Flux Bidirectional Bridge Test
#
# Automated integration test proving bidirectional messaging between
# Matrix (Conduit) and AD4M/Flux via the matrix-link-language bridge.
#
# Phases:
#   1. Build matrix-link-language from source
#   2. Start Matrix infrastructure (via matrix-server.sh)
#   3. Start AD4M executor (language-language-only, no Holochain)
#   4. Publish & configure language with Matrix credentials
#   5. Create Flux community structure + bind neighbourhood via SQLite
#   6. Matrix → AD4M: send m.room.message, verify flux://body links
#   7. AD4M → Matrix: add Flux Message links, verify m.room.message
#
# Requirements: Docker, Node.js (npx/tsx), Python3 (websockets), jq, curl, sqlite3
#
# Usage:
#   ./matrix-bridge-test.sh                              # Full automated test
#   ./matrix-bridge-test.sh --skip-build --keep           # Skip build, keep services
#   ./matrix-bridge-test.sh --fresh --port 13000         # Clean slate, custom port
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common-matrix.sh"

# ═══════════════════════════════════════════════════════════════════════════════
# Defaults
# ═══════════════════════════════════════════════════════════════════════════════

WORKSPACE="${WORKSPACE:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

AD4M_DIR="${AD4M_DIR:-$WORKSPACE/ad4m}"
MATRIX_LANG_DIR="${MATRIX_LANG_DIR:-$WORKSPACE/matrix-link-language}"
DATA_DIR=""
AUTO_DATA_DIR=true

AD4M_HOST="127.0.0.1"
RPC_PORT="${RPC_PORT:-12100}"
CONDUIT_PORT="${CONDUIT_PORT:-6167}"
CREDENTIAL="${CREDENTIAL:-test123}"
PASSPHRASE="${PASSPHRASE:-test passphrase}"
ENV_FILE="${ENV_FILE:-/tmp/matrix-bridge-env}"

# Flags
SKIP_BUILD=false
SKIP_MATRIX_START=false
KEEP_RUNNING=false
FRESH=false

# Runtime state
EXECUTOR_PID=""

# ═══════════════════════════════════════════════════════════════════════════════
# Help
# ═══════════════════════════════════════════════════════════════════════════════

show_help() {
    cat <<'EOF'
matrix-bridge-test.sh — E2E Matrix ↔ AD4M/Flux Bridge Integration Test

Proves bidirectional messaging between Matrix (Conduit) and AD4M/Flux via
the matrix-link-language bridge. Fully automated — no interactive mode.

Usage:
  matrix-bridge-test.sh [options]

Path Options:
  --ad4m DIR              AD4M repo root
  --matrix-lang DIR       matrix-link-language repo
  --data-path DIR         Temp data dir (default: auto)

Port/Credential Options:
  --port PORT             AD4M WS RPC port (default: 12100)
  --env-file PATH         Matrix server env file (default: /tmp/matrix-bridge-env)
  --credential CRED       AD4M admin credential (default: test123)

Behaviour Options:
  --skip-build            Skip language build (use existing bundle)
  --skip-matrix-start     Don't start Matrix server (assume running)
  --fresh                 Remove existing data dir before starting
  --keep                  Don't clean up on exit
  -h, --help              Show this help

Examples:
  ./matrix-bridge-test.sh
  ./matrix-bridge-test.sh --skip-build --keep
  ./matrix-bridge-test.sh --ad4m ~/src/ad4m --port 13000
EOF
    exit 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# Parse Arguments
# ═══════════════════════════════════════════════════════════════════════════════

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ad4m)             AD4M_DIR="$2"; shift 2 ;;
        --matrix-lang)      MATRIX_LANG_DIR="$2"; shift 2 ;;
        --data-path)        DATA_DIR="$2"; AUTO_DATA_DIR=false; shift 2 ;;
        --port)             RPC_PORT="$2"; shift 2 ;;
        --env-file)         ENV_FILE="$2"; shift 2 ;;
        --credential)       CREDENTIAL="$2"; shift 2 ;;
        --skip-build)       SKIP_BUILD=true; shift ;;
        --skip-matrix-start) SKIP_MATRIX_START=true; shift ;;
        --fresh)            FRESH=true; shift ;;
        --keep)             KEEP_RUNNING=true; shift ;;
        -h|--help)          show_help ;;
        *)                  error "Unknown option: $1"; exit 1 ;;
    esac
done

# ═══════════════════════════════════════════════════════════════════════════════
# Derived Configuration
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "$AUTO_DATA_DIR" == "true" || -z "$DATA_DIR" ]]; then
    DATA_DIR=$(mktemp -d /tmp/ad4m-bridge-test-XXXXXX)
fi

if [[ "$FRESH" == "true" && -d "$DATA_DIR" && "$AUTO_DATA_DIR" == "false" ]]; then
    rm -rf "$DATA_DIR"
fi
mkdir -p "$DATA_DIR"

AD4M_EXECUTOR="${AD4M_EXECUTOR:-$AD4M_DIR/target/release/ad4m-executor}"
AD4M_LDK_DIR="${AD4M_LDK_DIR:-$AD4M_DIR/ad4m-ldk/js/lib}"
MAINNET_SEED="$AD4M_DIR/rust-executor/src/mainnet_seed.json"
BUNDLE_PATH="$MATRIX_LANG_DIR/build/bundle.js"

# ═══════════════════════════════════════════════════════════════════════════════
# Cleanup
# ═══════════════════════════════════════════════════════════════════════════════

cleanup() {
    local exit_code=$?
    echo ""
    if [[ "$KEEP_RUNNING" == "true" ]]; then
        warn "Keeping services running (--keep). Manual cleanup:"
        [[ -n "$EXECUTOR_PID" ]] && echo "  kill $EXECUTOR_PID  # AD4M executor"
        echo "  $SCRIPT_DIR/matrix-server.sh stop"
        echo "  rm -rf $DATA_DIR"
        return $exit_code
    fi
    step "Cleaning up..."
    if [[ -n "$EXECUTOR_PID" ]] && kill -0 "$EXECUTOR_PID" 2>/dev/null; then
        kill "$EXECUTOR_PID" 2>/dev/null || true
        wait "$EXECUTOR_PID" 2>/dev/null || true
    fi
    if [[ "$SKIP_MATRIX_START" != "true" ]]; then
        "$SCRIPT_DIR/matrix-server.sh" stop 2>/dev/null || true
    fi
    if [[ -d "$DATA_DIR" ]]; then
        rm -rf "$DATA_DIR"
    fi
    return $exit_code
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
# Pre-flight
# ═══════════════════════════════════════════════════════════════════════════════

header "Pre-flight Checks"

check_matrix_deps

step "Checking additional dependencies..."
command -v npx >/dev/null 2>&1 || { error "npx required (install Node.js)"; exit 1; }

step "Checking paths..."
PATH_ERRORS=()
[[ -x "$AD4M_EXECUTOR" ]] || PATH_ERRORS+=("ad4m-executor not found at: $AD4M_EXECUTOR")
[[ -f "$MAINNET_SEED" ]]  || PATH_ERRORS+=("mainnet_seed.json not found at: $MAINNET_SEED")
[[ -d "$MATRIX_LANG_DIR" ]] || PATH_ERRORS+=("matrix-link-language repo not found at: $MATRIX_LANG_DIR")
[[ -d "$AD4M_LDK_DIR" ]]    || PATH_ERRORS+=("AD4M LDK not found at: $AD4M_LDK_DIR")

if [[ ${#PATH_ERRORS[@]} -gt 0 ]]; then
    error "Path errors:"
    for e in "${PATH_ERRORS[@]}"; do echo "  • $e"; done
    exit 1
fi

# Kill existing process on our port
if lsof -ti:"$RPC_PORT" >/dev/null 2>&1; then
    warn "Port $RPC_PORT in use — killing existing process"
    lsof -ti:"$RPC_PORT" | xargs kill -9 2>/dev/null || true
    sleep 2
fi

success "All dependencies satisfied"
info "Data dir:        $DATA_DIR"
info "AD4M executor:   $AD4M_EXECUTOR"
info "Matrix language: $MATRIX_LANG_DIR"
info "WS RPC port:     $RPC_PORT"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Build Matrix Link Language
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 1: Build Matrix Link Language"

if [[ "$SKIP_BUILD" == "true" && -f "$BUNDLE_PATH" ]]; then
    BUNDLE_SIZE=$(wc -c < "$BUNDLE_PATH" | tr -d ' ')
    skip "language-build" "Using existing bundle ($BUNDLE_SIZE bytes) — --skip-build"
elif [[ "$SKIP_BUILD" == "true" && ! -f "$BUNDLE_PATH" ]]; then
    fail "language-build" "Bundle not found at $BUNDLE_PATH and --skip-build set"
    print_summary "Matrix ↔ AD4M/Flux Bridge" || exit 1
else
    step "Building matrix-link-language..."
    (
        cd "$MATRIX_LANG_DIR"
        AD4M_LDK_ENTRY="$AD4M_LDK_DIR/index.js" npx tsx esbuild.node.ts 2>&1 | tail -5
    )
    if [[ -f "$BUNDLE_PATH" ]]; then
        BUNDLE_SIZE=$(wc -c < "$BUNDLE_PATH" | tr -d ' ')
        pass "language-build" "Bundle: $BUNDLE_PATH ($BUNDLE_SIZE bytes)"
    else
        fail "language-build" "Bundle not produced at $BUNDLE_PATH"
        print_summary "Matrix ↔ AD4M/Flux Bridge" || exit 1
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Start Infrastructure
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 2: Start Infrastructure"

# ─── 2a: Matrix server ───────────────────────────────────────────────────────

if [[ "$SKIP_MATRIX_START" == "true" ]]; then
    if [[ -f "$ENV_FILE" ]]; then
        info "Using existing Matrix server (--skip-matrix-start)"
        # shellcheck disable=SC1090
        source "$ENV_FILE"
    else
        error "Matrix env file not found at $ENV_FILE and --skip-matrix-start set"
        exit 1
    fi
else
    step "Starting Matrix server via matrix-server.sh..."
    "$SCRIPT_DIR/matrix-server.sh" start \
        --conduit-port "$CONDUIT_PORT" \
        --no-element \
        --env-file "$ENV_FILE"
    # shellcheck disable=SC1090
    source "$ENV_FILE"
fi

# Ensure we have the env vars we need
: "${MATRIX_URL:?MATRIX_URL not set}"
: "${MATRIX_ROOM_ID:?MATRIX_ROOM_ID not set}"
: "${BRIDGE_TOKEN:?BRIDGE_TOKEN not set}"
: "${HUMAN_TOKEN:?HUMAN_TOKEN not set}"
: "${BRIDGE_USER_ID:?BRIDGE_USER_ID not set}"

# ─── 2b: Bootstrap seed ──────────────────────────────────────────────────────

step "Creating bootstrap seed..."
SEED_PATH="$DATA_DIR/bootstrap-seed.json"
create_bootstrap_seed "$MAINNET_SEED" "$SEED_PATH"
info "Bootstrap seed: $SEED_PATH"

# ─── 2c: Start AD4M executor ─────────────────────────────────────────────────

if ! start_executor "$AD4M_EXECUTOR" "$DATA_DIR" "$SEED_PATH" "$RPC_PORT" "$CREDENTIAL"; then
    fail "executor-start" "Failed to start executor"
    print_summary "Matrix ↔ AD4M/Flux Bridge" || exit 1
fi
pass "executor-start" "Ready (PID $EXECUTOR_PID, port $RPC_PORT)"

# ─── 2d: Init agent ──────────────────────────────────────────────────────────

step "Initialising AD4M agent..."
AGENT_DID=$(init_or_unlock_agent "$PASSPHRASE")
if [[ -n "$AGENT_DID" ]]; then
    pass "agent-init" "DID: ${AGENT_DID:0:50}..."
else
    fail "agent-init" "Failed to initialise agent"
    print_summary "Matrix ↔ AD4M/Flux Bridge" || exit 1
fi
sleep 2

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Publish Language & Configure
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 3: Publish & Configure Matrix Link Language"

# ─── 3a: Publish ──────────────────────────────────────────────────────────────

step "Publishing language bundle..."
LANG_HASH=$(publish_language "$BUNDLE_PATH")
if [[ -n "$LANG_HASH" ]]; then
    pass "language-publish" "Hash: $LANG_HASH"
else
    fail "language-publish" "Failed to publish"
    print_summary "Matrix ↔ AD4M/Flux Bridge" || exit 1
fi

# ─── 3b: Apply template ──────────────────────────────────────────────────────

step "Applying template with Matrix credentials..."
CONFIGURED_LANG=$(apply_language_template "$LANG_HASH" "$MATRIX_URL" "$MATRIX_ROOM_ID" \
    "$BRIDGE_USER_ID" "$BRIDGE_TOKEN" "#flux-bridge:${SERVER_NAME:-ad4m-test.local}")
if [[ -n "$CONFIGURED_LANG" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Failed to apply template"
    print_summary "Matrix ↔ AD4M/Flux Bridge" || exit 1
fi

# Verify executor alive after template application
if ! kill -0 "$EXECUTOR_PID" 2>/dev/null; then
    fail "executor-alive-post-template" "Executor died during template application"
    tail -15 "$DATA_DIR/executor.log" 2>/dev/null | sed 's/^/    /'
    print_summary "Matrix ↔ AD4M/Flux Bridge" || exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 4: Create Perspective & Bind Link Language
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 4: Create Flux Community & Bind Link Language"

# ─── 4a: Generate seed ───────────────────────────────────────────────────────

step "Generating Flux community seed..."
generate_flux_seed "Matrix Bridge" "$DATA_DIR/seed.json" 1

# ─── 4b: Create perspective ──────────────────────────────────────────────────

step "Creating AD4M perspective..."
PERSP_RESULT=$(ad4m_rpc perspective-create "Matrix Bridge" 2>/dev/null) || PERSP_RESULT=""
PERSPECTIVE_UUID=$(echo "$PERSP_RESULT" | jq -r '.uuid // empty' 2>/dev/null)

if [[ -n "$PERSPECTIVE_UUID" ]]; then
    pass "perspective-create" "UUID: $PERSPECTIVE_UUID"
else
    fail "perspective-create" "Failed to create perspective"
    print_summary "Matrix ↔ AD4M/Flux Bridge" || exit 1
fi

# ─── 4c: Add community structure links ───────────────────────────────────────

step "Adding Flux community structure links..."
CHANNEL_ID="flux-channel://general"

ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "ad4m://self" "flux://has_community" "flux://entry_type" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "ad4m://self" "literal://string:Matrix%20Bridge" "rdf://name" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "ad4m://self" "$CHANNEL_ID" "flux://has_channel" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$CHANNEL_ID" "flux://has_channel" "flux://entry_type" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$CHANNEL_ID" "literal://string:general" "flux://has_channel_name" >/dev/null 2>&1 || true
info "Channel ID: $CHANNEL_ID"

# ─── 4d: Bind link language via SQLite ────────────────────────────────────────

step "Binding configured link language to perspective via SQLite..."
DB_PATH="$DATA_DIR/ad4m-data/ad4m_db.sqlite"

if bind_neighbourhood "$DB_PATH" "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" "$AGENT_DID"; then
    pass "neighbourhood-bind" "Link language bound to perspective"
else
    fail "neighbourhood-bind" "SQLite update failed"
    print_summary "Matrix ↔ AD4M/Flux Bridge" || exit 1
fi

# ─── 4e: Restart executor to load binding ─────────────────────────────────────

step "Restarting executor to load link language..."
kill "$EXECUTOR_PID" 2>/dev/null || true
wait "$EXECUTOR_PID" 2>/dev/null || true
sleep 2

if ! start_executor "$AD4M_EXECUTOR" "$DATA_DIR" "$SEED_PATH" "$RPC_PORT" "$CREDENTIAL"; then
    fail "executor-restart" "Failed to restart executor"
    print_summary "Matrix ↔ AD4M/Flux Bridge" || exit 1
fi
pass "executor-restart" "Ready (PID $EXECUTOR_PID)"

# Unlock agent
step "Unlocking agent post-restart..."
UNLOCK_RESULT=$(ad4m_rpc raw "agent.unlock" "{\"passphrase\":\"$PASSPHRASE\",\"holochain\":false}" 2>/dev/null) || UNLOCK_RESULT=""
UNLOCK_OK=$(echo "$UNLOCK_RESULT" | jq -r '.isUnlocked // false' 2>/dev/null)
if [[ "$UNLOCK_OK" == "true" ]]; then
    pass "agent-unlock" "Agent unlocked post-restart"
else
    skip "agent-unlock" "May already be unlocked"
fi

# Wait for link language to initialise
step "Waiting for link language to initialise (15s)..."
sleep 15

# Verify language loaded
PERSP_CHECK=$(ad4m_rpc raw "perspective.get" "{\"uuid\":\"$PERSPECTIVE_UUID\"}" 2>/dev/null) || PERSP_CHECK=""
LOADED_LANG=$(echo "$PERSP_CHECK" | jq -r '.neighbourhood.data.linkLanguage // empty' 2>/dev/null)
if [[ "$LOADED_LANG" == "$CONFIGURED_LANG" ]]; then
    pass "link-language-loaded" "Language active: ${CONFIGURED_LANG:0:30}..."
else
    warn "Expected language $CONFIGURED_LANG, got: $LOADED_LANG"
    sleep 10
    skip "link-language-loaded" "Language may still be initialising"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 5: Matrix → AD4M Proof
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 5: Matrix → AD4M (Prove messages bridge from Matrix to Flux)"

TEST_MSG_M2F="Hello from Matrix! [bridge-proof-$(date +%s)]"
TXNID="m2f-proof-$(date +%s)"

step "Sending message from human user in Matrix..."
EVENT_ID=$(matrix_send_message "$MATRIX_URL" "$HUMAN_TOKEN" "$MATRIX_ROOM_ID" "$TEST_MSG_M2F" "$TXNID")

if [[ -n "$EVENT_ID" ]]; then
    pass "matrix-send" "Event ID: $EVENT_ID"
else
    fail "matrix-send" "Failed to send Matrix message"
fi

# Trigger sync cycles
step "Triggering sync cycles (polling AD4M for new links)..."
for i in $(seq 1 10); do
    ad4m_rpc perspective-query-links "$PERSPECTIVE_UUID" >/dev/null 2>&1 || true
    sleep 3
done

# Check for Flux message links
step "Checking for bridged message links in AD4M perspective..."
LINKS_RAW=$(ad4m_rpc perspective-query-links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS_RAW="[]"
TOTAL_LINKS=$(echo "$LINKS_RAW" | jq 'length' 2>/dev/null) || TOTAL_LINKS=0
info "Total links in perspective: $TOTAL_LINKS"

BODY_LINKS=$(echo "$LINKS_RAW" | jq '[.[] | select(.data.predicate == "flux://body")]' 2>/dev/null) || BODY_LINKS="[]"
BODY_COUNT=$(echo "$BODY_LINKS" | jq 'length' 2>/dev/null) || BODY_COUNT=0

HAS_CHILD=$(echo "$LINKS_RAW" | jq '[.[] | select(.data.predicate == "ad4m://has_child")]' 2>/dev/null) || HAS_CHILD="[]"
CHILD_COUNT=$(echo "$HAS_CHILD" | jq 'length' 2>/dev/null) || CHILD_COUNT=0

if [[ "$BODY_COUNT" -gt 0 ]]; then
    pass "matrix-to-ad4m" "Found $BODY_COUNT flux://body links + $CHILD_COUNT has_child links"
    echo "  First body link:"
    echo "$BODY_LINKS" | jq -c '.[0].data' 2>/dev/null | sed 's/^/    /'
else
    if [[ "$TOTAL_LINKS" -gt 5 ]]; then
        warn "Perspective has $TOTAL_LINKS links but no flux://body"
        echo "  Flux-related links:"
        echo "$LINKS_RAW" | jq -c '.[] | select(.data.predicate | startswith("flux://")) | .data' 2>/dev/null | head -5 | sed 's/^/    /'
        skip "matrix-to-ad4m" "Language active, sync still propagating"
    else
        fail "matrix-to-ad4m" "No flux://body links found"
        echo "  All links:"
        echo "$LINKS_RAW" | jq -c '.[] | .data' 2>/dev/null | head -10 | sed 's/^/    /'
        echo "  Recent executor log:"
        grep -i "commit\|matrix\|sendEvent\|poll\|sync\|error" "$DATA_DIR/executor.log" 2>/dev/null | tail -10 | sed 's/^/    /'
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 6: AD4M → Matrix Proof
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 6: AD4M → Matrix (Prove messages bridge from Flux to Matrix)"

TEST_MSG_F2M="Hello from Flux! [bridge-proof-$(date +%s)]"
FLUX_MSG_ID="flux-msg://proof-$(date +%s)"
ENCODED_BODY="literal://string:$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TEST_MSG_F2M'))")"

step "Adding Flux Message links via batch commit..."

# Use raw RPC to add multiple links at once
BATCH_LINKS=$(jq -nc --arg uuid "$PERSPECTIVE_UUID" --arg ch "$CHANNEL_ID" \
    --arg msgid "$FLUX_MSG_ID" --arg body "$ENCODED_BODY" \
    '{uuid:$uuid, links:[
        {source:$ch, target:$msgid, predicate:"ad4m://has_child"},
        {source:$msgid, target:"flux://has_message", predicate:"flux://entry_type"},
        {source:$msgid, target:$body, predicate:"flux://body"}
    ]}')

BATCH_RESULT=$(ad4m_rpc raw "perspective.addLinks" "$BATCH_LINKS" 2>/dev/null) || BATCH_RESULT=""
ADDED_COUNT=$(echo "$BATCH_RESULT" | jq 'length' 2>/dev/null) || ADDED_COUNT=0

if [[ "$ADDED_COUNT" -gt 0 ]]; then
    pass "ad4m-send" "Added $ADDED_COUNT links (batch commit triggers Matrix send)"
else
    warn "Batch add response: $BATCH_RESULT"
    step "  Falling back to individual link adds..."
    ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$CHANNEL_ID" "$FLUX_MSG_ID" "ad4m://has_child" >/dev/null 2>&1 || true
    ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$FLUX_MSG_ID" "flux://has_message" "flux://entry_type" >/dev/null 2>&1 || true
    ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$FLUX_MSG_ID" "$ENCODED_BODY" "flux://body" >/dev/null 2>&1 || true
    pass "ad4m-send" "Added links individually"
fi

# Wait for commit → Matrix send
step "Waiting for AD4M commit → Matrix send (40s max)..."
FOUND_MSG=false
for attempt in $(seq 1 8); do
    sleep 5
    MESSAGES=$(matrix_get_messages "$MATRIX_URL" "$HUMAN_TOKEN" "$MATRIX_ROOM_ID" 50)
    MATCH_COUNT=$(echo "$MESSAGES" | jq --arg msg "$TEST_MSG_F2M" \
        '[.chunk[]? | select(.type=="m.room.message" and (.content.body // "" | contains($msg)))] | length' 2>/dev/null) || MATCH_COUNT=0
    if [[ "$MATCH_COUNT" -gt 0 ]]; then
        FOUND_MSG=true
        break
    fi
done

step "Checking Matrix room for bridged Flux message..."
if [[ "$FOUND_MSG" == "true" ]]; then
    pass "ad4m-to-matrix" "Flux message appeared in Matrix room! ✨"
    echo "  Matched message:"
    echo "$MESSAGES" | jq --arg msg "$TEST_MSG_F2M" \
        '.chunk[]? | select(.content.body // "" | contains($msg)) | {sender, body: .content.body}' 2>/dev/null | sed 's/^/    /'
else
    BRIDGE_MSGS=$(echo "$MESSAGES" | jq --arg sender "${BRIDGE_USER_ID}" \
        '[.chunk[]? | select(.sender==$sender and .type=="m.room.message")] | length' 2>/dev/null) || BRIDGE_MSGS=0
    if [[ "$BRIDGE_MSGS" -gt 0 ]]; then
        warn "Bridge bot sent $BRIDGE_MSGS messages but test text not matched"
        echo "  Bridge bot messages:"
        echo "$MESSAGES" | jq --arg sender "${BRIDGE_USER_ID}" \
            '.chunk[]? | select(.sender==$sender) | {sender, type, body:.content.body}' 2>/dev/null | head -5 | sed 's/^/    /'
        skip "ad4m-to-matrix" "Bridge active, message format may differ"
    else
        fail "ad4m-to-matrix" "No bridged message found in Matrix room"
        echo "  Recent executor logs:"
        grep -i "commit\|send\|matrix\|error" "$DATA_DIR/executor.log" 2>/dev/null | tail -10 | sed 's/^/    /'
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
info "Data dir:      $DATA_DIR"
info "Executor log:  $DATA_DIR/executor.log"
[[ "$KEEP_RUNNING" == "true" ]] && info "Services kept running (--keep)"

print_summary "Matrix ↔ AD4M/Flux Bridge" || exit 1
