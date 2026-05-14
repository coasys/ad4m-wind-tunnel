#!/usr/bin/env bash
# matrix-community-bridge.sh — Bridge/migrate a real Matrix community to AD4M/Flux
#
# Connects to an existing Matrix homeserver, lets the user pick a room,
# starts AD4M, builds & publishes the matrix-link-language, creates a
# Flux community structure, optionally backfills history, opens Flux
# in a browser, and keeps the bridge running until Ctrl+C.
#
# Usage:
#   ./matrix-community-bridge.sh --homeserver https://matrix.org --user alice --password secret
#   ./matrix-community-bridge.sh --homeserver http://localhost:8448 --access-token syt_xxx --room-id '!abc:server'
#
# See --help for full options.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common-matrix.sh"

# ═══════════════════════════════════════════════════════════════════════════════
# Defaults
# ═══════════════════════════════════════════════════════════════════════════════

WORKSPACE="${WORKSPACE:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

HOMESERVER=""
ACCESS_TOKEN=""
MATRIX_USER=""
MATRIX_PASSWORD=""
ROOM_ID=""
AD4M_DIR="${AD4M_DIR:-$WORKSPACE/ad4m}"
FLUX_DIR="${FLUX_DIR:-$WORKSPACE/flux}"
MATRIX_LANG_DIR="${MATRIX_LANG_DIR:-$WORKSPACE/matrix-link-language}"
DATA_DIR=""
AUTO_DATA_DIR=true

AD4M_HOST="127.0.0.1"
RPC_PORT="${RPC_PORT:-12100}"
FLUX_PORT="${FLUX_PORT:-3030}"
CREDENTIAL="${CREDENTIAL:-test123}"
PASSPHRASE="${PASSPHRASE:-test passphrase}"

BACKFILL=0
SKIP_BUILD=false
FRESH=false

# Runtime state
EXECUTOR_PID=""
FLUX_PID=""

# ═══════════════════════════════════════════════════════════════════════════════
# Help
# ═══════════════════════════════════════════════════════════════════════════════

show_help() {
    cat <<'EOF'
matrix-community-bridge.sh — Bridge a real Matrix community to AD4M/Flux

Connects to an existing Matrix homeserver, selects a room, builds the
matrix-link-language bridge, creates a Flux community, optionally backfills
history, and keeps the bridge running for real-time use.

Usage:
  matrix-community-bridge.sh [options]

Matrix Options:
  --homeserver URL        Matrix homeserver URL (required, or prompted)
  --access-token TOKEN    Matrix access token (skip login)
  --user USERNAME         Matrix username (for login)
  --password PASS         Matrix password (for login)
  --room-id ID            Room to bridge (or list and pick interactively)

Path Options:
  --ad4m DIR              AD4M repo root
  --flux DIR              Flux repo root (for serving UI)
  --matrix-lang DIR       matrix-link-language repo
  --data-path DIR         Temp data dir (default: auto)

Port/Credential Options:
  --port PORT             AD4M WS RPC port (default: 12100)
  --flux-port PORT        Flux preview port (default: 3030)
  --credential CRED       AD4M admin credential (default: test123)

Behaviour Options:
  --backfill N            Number of historical messages to import (default: 0)
  --skip-build            Skip language build
  --fresh                 Clean state before starting
  -h, --help              Show this help

Examples:
  ./matrix-community-bridge.sh --homeserver https://matrix.org --user alice --password secret
  ./matrix-community-bridge.sh --homeserver http://localhost:8448 --access-token syt_xxx
  ./matrix-community-bridge.sh --homeserver http://localhost:6167 --user test --password test --backfill 100
EOF
    exit 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# Parse Arguments
# ═══════════════════════════════════════════════════════════════════════════════

while [[ $# -gt 0 ]]; do
    case "$1" in
        --homeserver)     HOMESERVER="$2"; shift 2 ;;
        --access-token)   ACCESS_TOKEN="$2"; shift 2 ;;
        --user)           MATRIX_USER="$2"; shift 2 ;;
        --password)       MATRIX_PASSWORD="$2"; shift 2 ;;
        --room-id)        ROOM_ID="$2"; shift 2 ;;
        --ad4m)           AD4M_DIR="$2"; shift 2 ;;
        --flux)           FLUX_DIR="$2"; shift 2 ;;
        --matrix-lang)    MATRIX_LANG_DIR="$2"; shift 2 ;;
        --data-path)      DATA_DIR="$2"; AUTO_DATA_DIR=false; shift 2 ;;
        --port)           RPC_PORT="$2"; shift 2 ;;
        --flux-port)      FLUX_PORT="$2"; shift 2 ;;
        --credential)     CREDENTIAL="$2"; shift 2 ;;
        --backfill)       BACKFILL="$2"; shift 2 ;;
        --skip-build)     SKIP_BUILD=true; shift ;;
        --fresh)          FRESH=true; shift ;;
        -h|--help)        show_help ;;
        *)                error "Unknown option: $1"; exit 1 ;;
    esac
done

# ═══════════════════════════════════════════════════════════════════════════════
# Interactive prompts for missing required values
# ═══════════════════════════════════════════════════════════════════════════════

if [[ -z "$HOMESERVER" ]]; then
    echo -n "Matrix homeserver URL: "
    read -r HOMESERVER
fi
[[ -z "$HOMESERVER" ]] && { error "Homeserver URL is required"; exit 1; }

# Strip trailing slash
HOMESERVER="${HOMESERVER%/}"

# Get access token if not provided
if [[ -z "$ACCESS_TOKEN" ]]; then
    if [[ -z "$MATRIX_USER" ]]; then
        echo -n "Matrix username: "
        read -r MATRIX_USER
    fi
    if [[ -z "$MATRIX_PASSWORD" ]]; then
        echo -n "Matrix password: "
        read -rs MATRIX_PASSWORD
        echo ""
    fi
    if [[ -n "$MATRIX_USER" && -n "$MATRIX_PASSWORD" ]]; then
        step "Logging in to $HOMESERVER as $MATRIX_USER..."
        LOGIN_RESP=$(curl -sf -X POST "${HOMESERVER}/_matrix/client/v3/login" \
            -H "Content-Type: application/json" \
            -d "$(jq -nc --arg u "$MATRIX_USER" --arg p "$MATRIX_PASSWORD" \
                '{type:"m.login.password", identifier:{type:"m.id.user",user:$u}, password:$p}')" 2>/dev/null) || LOGIN_RESP=""
        ACCESS_TOKEN=$(echo "$LOGIN_RESP" | jq -r '.access_token // empty' 2>/dev/null)
        MATRIX_USER_ID=$(echo "$LOGIN_RESP" | jq -r '.user_id // empty' 2>/dev/null)
        if [[ -z "$ACCESS_TOKEN" ]]; then
            error "Login failed: $LOGIN_RESP"
            exit 1
        fi
        success "Logged in as $MATRIX_USER_ID"
    else
        error "Need --access-token or --user/--password"
        exit 1
    fi
fi

# Get user ID if we don't have it
if [[ -z "${MATRIX_USER_ID:-}" ]]; then
    WHOAMI=$(curl -sf "${HOMESERVER}/_matrix/client/v3/account/whoami" \
        -H "Authorization: Bearer $ACCESS_TOKEN" 2>/dev/null) || WHOAMI=""
    MATRIX_USER_ID=$(echo "$WHOAMI" | jq -r '.user_id // empty' 2>/dev/null)
    if [[ -z "$MATRIX_USER_ID" ]]; then
        error "Could not determine user ID — is the access token valid?"
        exit 1
    fi
    info "Authenticated as $MATRIX_USER_ID"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Room selection
# ═══════════════════════════════════════════════════════════════════════════════

if [[ -z "$ROOM_ID" ]]; then
    header "Room Selection"
    step "Listing rooms you've joined..."

    ROOMS_JSON=$(matrix_list_rooms "$HOMESERVER" "$ACCESS_TOKEN")
    ROOM_COUNT=$(echo "$ROOMS_JSON" | jq 'length' 2>/dev/null) || ROOM_COUNT=0

    if [[ "$ROOM_COUNT" -eq 0 ]]; then
        error "No rooms found. Join a room first."
        exit 1
    fi

    echo ""
    echo "$ROOMS_JSON" | jq -r 'to_entries[] | "  [\(.key + 1)] \(.value.name) (\(.value.room_id))"' 2>/dev/null
    echo ""
    echo -n "Select room (1-$ROOM_COUNT): "
    read -r ROOM_CHOICE
    ROOM_IDX=$((ROOM_CHOICE - 1))
    ROOM_ID=$(echo "$ROOMS_JSON" | jq -r ".[$ROOM_IDX].room_id // empty" 2>/dev/null)
    ROOM_DISPLAY_NAME=$(echo "$ROOMS_JSON" | jq -r ".[$ROOM_IDX].name // empty" 2>/dev/null)

    if [[ -z "$ROOM_ID" ]]; then
        error "Invalid selection"
        exit 1
    fi
    success "Selected: $ROOM_DISPLAY_NAME ($ROOM_ID)"
else
    # Get room name
    ROOM_STATE=$(curl -sf "${HOMESERVER}/_matrix/client/v3/rooms/${ROOM_ID}/state/m.room.name" \
        -H "Authorization: Bearer $ACCESS_TOKEN" 2>/dev/null) || ROOM_STATE="{}"
    ROOM_DISPLAY_NAME=$(echo "$ROOM_STATE" | jq -r '.name // "(unnamed)"' 2>/dev/null)
    info "Bridging room: $ROOM_DISPLAY_NAME ($ROOM_ID)"
fi

# Get room topic
ROOM_TOPIC_STATE=$(curl -sf "${HOMESERVER}/_matrix/client/v3/rooms/${ROOM_ID}/state/m.room.topic" \
    -H "Authorization: Bearer $ACCESS_TOKEN" 2>/dev/null) || ROOM_TOPIC_STATE="{}"
ROOM_TOPIC=$(echo "$ROOM_TOPIC_STATE" | jq -r '.topic // ""' 2>/dev/null)

# ═══════════════════════════════════════════════════════════════════════════════
# Derived Configuration
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "$AUTO_DATA_DIR" == "true" || -z "$DATA_DIR" ]]; then
    DATA_DIR=$(mktemp -d /tmp/ad4m-community-bridge-XXXXXX)
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
    step "Cleaning up..."
    if [[ -n "$EXECUTOR_PID" ]] && kill -0 "$EXECUTOR_PID" 2>/dev/null; then
        kill "$EXECUTOR_PID" 2>/dev/null || true
        wait "$EXECUTOR_PID" 2>/dev/null || true
    fi
    if [[ -n "$FLUX_PID" ]] && kill -0 "$FLUX_PID" 2>/dev/null; then
        kill "$FLUX_PID" 2>/dev/null || true
    fi
    info "Data dir preserved: $DATA_DIR"
    return $exit_code
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
# Pre-flight
# ═══════════════════════════════════════════════════════════════════════════════

header "Pre-flight Checks"

check_matrix_deps
command -v npx >/dev/null 2>&1 || { error "npx required (install Node.js)"; exit 1; }

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

success "Pre-flight OK"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Build Language
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 1: Build Matrix Link Language"

if [[ "$SKIP_BUILD" == "true" && -f "$BUNDLE_PATH" ]]; then
    BUNDLE_SIZE=$(wc -c < "$BUNDLE_PATH" | tr -d ' ')
    info "Using existing bundle ($BUNDLE_SIZE bytes) — --skip-build"
elif [[ "$SKIP_BUILD" == "true" && ! -f "$BUNDLE_PATH" ]]; then
    error "Bundle not found at $BUNDLE_PATH and --skip-build set"
    exit 1
else
    step "Building matrix-link-language..."
    (
        cd "$MATRIX_LANG_DIR"
        AD4M_LDK_ENTRY="$AD4M_LDK_DIR/index.js" npx tsx esbuild.node.ts 2>&1 | tail -5
    )
    if [[ -f "$BUNDLE_PATH" ]]; then
        BUNDLE_SIZE=$(wc -c < "$BUNDLE_PATH" | tr -d ' ')
        success "Bundle: $BUNDLE_PATH ($BUNDLE_SIZE bytes)"
    else
        error "Bundle not produced at $BUNDLE_PATH"
        exit 1
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Start AD4M Executor
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 2: Start AD4M Executor"

step "Creating bootstrap seed..."
SEED_PATH="$DATA_DIR/bootstrap-seed.json"
create_bootstrap_seed "$MAINNET_SEED" "$SEED_PATH"

if ! start_executor "$AD4M_EXECUTOR" "$DATA_DIR" "$SEED_PATH" "$RPC_PORT" "$CREDENTIAL"; then
    error "Failed to start executor"
    exit 1
fi
success "Executor ready (PID $EXECUTOR_PID, port $RPC_PORT)"

step "Initialising agent..."
AGENT_DID=$(init_or_unlock_agent "$PASSPHRASE")
if [[ -z "$AGENT_DID" ]]; then
    error "Failed to initialise agent"
    exit 1
fi
success "Agent DID: ${AGENT_DID:0:50}..."
sleep 2

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Publish & Configure Language
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 3: Publish & Configure Language"

step "Publishing language bundle..."
LANG_HASH=$(publish_language "$BUNDLE_PATH")
if [[ -z "$LANG_HASH" ]]; then
    error "Failed to publish language"
    exit 1
fi
success "Language hash: $LANG_HASH"

# Extract server name from user ID
SERVER_NAME=$(echo "$MATRIX_USER_ID" | sed 's/.*://')

# Get room alias (best effort)
ROOM_ALIAS=""
ALIAS_RESP=$(curl -sf "${HOMESERVER}/_matrix/client/v3/rooms/${ROOM_ID}/state/m.room.canonical_alias" \
    -H "Authorization: Bearer $ACCESS_TOKEN" 2>/dev/null) || ALIAS_RESP="{}"
ROOM_ALIAS=$(echo "$ALIAS_RESP" | jq -r '.alias // ""' 2>/dev/null)

step "Applying template for room $ROOM_ID..."
CONFIGURED_LANG=$(apply_language_template "$LANG_HASH" "$HOMESERVER" "$ROOM_ID" \
    "$MATRIX_USER_ID" "$ACCESS_TOKEN" "$ROOM_ALIAS")
if [[ -z "$CONFIGURED_LANG" ]]; then
    error "Failed to apply language template"
    exit 1
fi
success "Configured language: $CONFIGURED_LANG"

# Verify executor alive
if ! kill -0 "$EXECUTOR_PID" 2>/dev/null; then
    error "Executor died during template application"
    tail -15 "$DATA_DIR/executor.log" 2>/dev/null | sed 's/^/    /'
    exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 4: Create Flux Community & Bind
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 4: Create Flux Community & Bind Language"

# Generate seed with community name matching room
COMMUNITY_NAME="${ROOM_DISPLAY_NAME:-Matrix Bridge}"
step "Generating Flux community seed for '$COMMUNITY_NAME'..."
generate_flux_seed "$COMMUNITY_NAME" "$DATA_DIR/seed.json" 1

# Create perspective
step "Creating AD4M perspective..."
PERSP_RESULT=$(ad4m_rpc perspective-create "$COMMUNITY_NAME" 2>/dev/null) || PERSP_RESULT=""
PERSPECTIVE_UUID=$(echo "$PERSP_RESULT" | jq -r '.uuid // empty' 2>/dev/null)

if [[ -z "$PERSPECTIVE_UUID" ]]; then
    error "Failed to create perspective"
    exit 1
fi
success "Perspective UUID: $PERSPECTIVE_UUID"

# Add community structure links
step "Adding Flux community structure..."
CHANNEL_ID="flux-channel://general"
ENCODED_NAME="literal://string:$(python3 -c "import urllib.parse; print(urllib.parse.quote('$COMMUNITY_NAME'))")"

ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "ad4m://self" "flux://has_community" "flux://entry_type" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "ad4m://self" "$ENCODED_NAME" "rdf://name" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "ad4m://self" "$CHANNEL_ID" "flux://has_channel" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$CHANNEL_ID" "flux://has_channel" "flux://entry_type" >/dev/null 2>&1 || true
ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "$CHANNEL_ID" "literal://string:general" "flux://has_channel_name" >/dev/null 2>&1 || true

if [[ -n "$ROOM_TOPIC" ]]; then
    ENCODED_TOPIC="literal://string:$(python3 -c "import urllib.parse; print(urllib.parse.quote('$ROOM_TOPIC'))")"
    ad4m_rpc perspective-add-link "$PERSPECTIVE_UUID" "ad4m://self" "$ENCODED_TOPIC" "rdf://description" >/dev/null 2>&1 || true
fi
info "Community structure created"

# Bind language
step "Binding link language via SQLite..."
DB_PATH="$DATA_DIR/ad4m-data/ad4m_db.sqlite"
if bind_neighbourhood "$DB_PATH" "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" "$AGENT_DID"; then
    success "Link language bound"
else
    error "SQLite binding failed"
    exit 1
fi

# Restart executor
step "Restarting executor to load link language..."
kill "$EXECUTOR_PID" 2>/dev/null || true
wait "$EXECUTOR_PID" 2>/dev/null || true
sleep 2

if ! start_executor "$AD4M_EXECUTOR" "$DATA_DIR" "$SEED_PATH" "$RPC_PORT" "$CREDENTIAL"; then
    error "Failed to restart executor"
    exit 1
fi
success "Executor restarted (PID $EXECUTOR_PID)"

# Unlock agent
step "Unlocking agent post-restart..."
ad4m_rpc raw "agent.unlock" "{\"passphrase\":\"$PASSPHRASE\",\"holochain\":false}" >/dev/null 2>&1 || true

# Wait for language init
step "Waiting for link language to initialise (15s)..."
sleep 15

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 5: Backfill (optional)
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "$BACKFILL" -gt 0 ]]; then
    header "Phase 5: Backfill History ($BACKFILL messages)"

    step "Fetching last $BACKFILL messages from Matrix..."
    HISTORY=$(matrix_get_messages "$HOMESERVER" "$ACCESS_TOKEN" "$ROOM_ID" "$BACKFILL")
    MSG_COUNT=$(echo "$HISTORY" | jq '[.chunk[]? | select(.type=="m.room.message")] | length' 2>/dev/null) || MSG_COUNT=0
    info "Found $MSG_COUNT messages to backfill"

    BACKFILLED=0
    echo "$HISTORY" | jq -c '.chunk[]? | select(.type=="m.room.message") | {sender: .sender, body: .content.body, ts: .origin_server_ts}' 2>/dev/null | while read -r msg_json; do
        local_body=$(echo "$msg_json" | jq -r '.body // empty' 2>/dev/null)
        local_sender=$(echo "$msg_json" | jq -r '.sender // empty' 2>/dev/null)
        if [[ -n "$local_body" ]]; then
            FLUX_MSG_ID="flux-msg://backfill-$(date +%s%N)"
            ENCODED_BODY="literal://string:$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$local_body'''))" 2>/dev/null)"
            # Use raw RPC to add links in batch
            BATCH_LINKS=$(jq -nc --arg uuid "$PERSPECTIVE_UUID" --arg ch "$CHANNEL_ID" \
                --arg msgid "$FLUX_MSG_ID" --arg body "$ENCODED_BODY" \
                '{uuid:$uuid, links:[
                    {source:$ch, target:$msgid, predicate:"ad4m://has_child"},
                    {source:$msgid, target:"flux://has_message", predicate:"flux://entry_type"},
                    {source:$msgid, target:$body, predicate:"flux://body"}
                ]}')
            ad4m_rpc raw "perspective.addLinks" "$BATCH_LINKS" >/dev/null 2>&1 || true
            ((BACKFILLED++)) || true
        fi
    done
    success "Backfilled $BACKFILLED messages"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 6: Serve Flux & Open Browser
# ═══════════════════════════════════════════════════════════════════════════════

header "Phase 6: Serve Flux UI"

# Serve Flux if available
if [[ -d "$FLUX_DIR/app/dist" ]]; then
    step "Serving Flux on port $FLUX_PORT..."
    pkill -f "vite.*preview.*${FLUX_PORT}" 2>/dev/null || true
    (cd "$FLUX_DIR/app" && npx vite preview --port "$FLUX_PORT" > "$DATA_DIR/flux-serve.log" 2>&1) &
    FLUX_PID=$!

    if wait_for_url "http://localhost:${FLUX_PORT}" "Flux" 10; then
        success "Flux at http://localhost:${FLUX_PORT}"
    else
        warn "Flux not serving — build with: cd $FLUX_DIR/app && pnpm build"
    fi

    # Create multi-user test account
    FLUX_EMAIL="dev@test.com"
    FLUX_PASS="test123"
    step "Creating Flux test user ($FLUX_EMAIL)..."

    CREATE_USER=$(ad4m_rpc raw "user.create" "{\"email\":\"$FLUX_EMAIL\",\"password\":\"$FLUX_PASS\"}" 2>/dev/null) || CREATE_USER=""
    USER_JWT=$(echo "$CREATE_USER" | jq -r '.jwt // empty' 2>/dev/null)
    if [[ -z "$USER_JWT" ]]; then
        LOGIN_USER=$(ad4m_rpc raw "user.login" "{\"email\":\"$FLUX_EMAIL\",\"password\":\"$FLUX_PASS\"}" 2>/dev/null) || LOGIN_USER=""
        USER_JWT=$(echo "$LOGIN_USER" | jq -r '.jwt // empty' 2>/dev/null)
    fi
    [[ -n "$USER_JWT" ]] && info "Flux user authenticated"

    # Try ad4m-flux-browser-auth.sh from ad4m-devtools (optional)
    BROWSER_AUTH_CANDIDATES=(
        "${DEVTOOLS_DIR:-$WORKSPACE/ad4m-devtools}/scripts/ad4m-flux-browser-auth.sh"
    )
    BROWSER_AUTH=""
    for candidate in "${BROWSER_AUTH_CANDIDATES[@]}"; do
        if [[ -x "$candidate" ]]; then
            BROWSER_AUTH="$candidate"
            break
        fi
    done

    if [[ -n "$BROWSER_AUTH" ]]; then
        step "Running browser auth..."
        bash "$BROWSER_AUTH" \
            --executor-url "http://127.0.0.1:${RPC_PORT}" \
            --flux-url "http://localhost:${FLUX_PORT}" \
            --email "$FLUX_EMAIL" \
            --password "$FLUX_PASS" \
            --admin-credential "$CREDENTIAL" \
            --flux-dir "$FLUX_DIR" \
            2>&1 | sed 's/^/  [flux-auth] /' || warn "Browser auth failed — open manually"
    else
        open "http://localhost:${FLUX_PORT}" 2>/dev/null || true
    fi
else
    warn "Flux dist not found at $FLUX_DIR/app/dist"
    info "Build with: cd $FLUX_DIR/app && pnpm build"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Running
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}═══ Bridge Running ═══${NC}"
echo ""
echo "  Matrix:          $HOMESERVER"
echo "  Room:            $ROOM_DISPLAY_NAME ($ROOM_ID)"
echo "  User:            $MATRIX_USER_ID"
echo ""
echo "  AD4M WS RPC:     ws://127.0.0.1:${RPC_PORT}/api/v1/ws"
echo "  Perspective:     $PERSPECTIVE_UUID"
echo "  Language:        ${CONFIGURED_LANG:0:40}..."
echo ""
if [[ -n "$FLUX_PID" ]] && kill -0 "$FLUX_PID" 2>/dev/null; then
    echo "  Flux:            http://localhost:${FLUX_PORT}"
    echo ""
fi
echo -e "  ${BOLD}Matrix messages ↔ Flux links are now bridging in real-time${NC}"
echo ""
echo -e "  ${CYAN}Press Ctrl+C to stop.${NC}"

# Wait for executor (cleanup on Ctrl+C via trap)
wait "$EXECUTOR_PID" 2>/dev/null || true
