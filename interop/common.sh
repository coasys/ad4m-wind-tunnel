#!/usr/bin/env bash
# common.sh — Shared functions for AD4M ↔ Native Protocol interop tests
# Runs FROM local Mac, SSH to Device A for executor/Docker operations
# shellcheck disable=SC2034

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'  # No color

info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✅${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}❌${NC} $*"; }
header()  { echo -e "\n${BOLD}${CYAN}═══ $* ═══${NC}\n"; }
step()    { echo -e "${BOLD}→${NC} $*"; }

# ─── Python / websockets dependency ─────────────────────────────────────────

check_deps() {
    if ! python3 -c "import websockets" 2>/dev/null; then
        error "Python 'websockets' package is required."
        echo "  Install with: pip3 install websockets"
        exit 1
    fi

    if ! command -v jq &>/dev/null; then
        error "jq is required."
        echo "  Install with: brew install jq"
        exit 1
    fi

    if ! command -v curl &>/dev/null; then
        error "curl is required."
        exit 1
    fi
}

AD4M_RPC="$REPO_DIR/scripts/ad4m-rpc.py"
if [[ ! -f "$AD4M_RPC" ]]; then
    echo "ERROR: ad4m-rpc.py not found at $AD4M_RPC" >&2
    exit 1
fi

# ─── Config ──────────────────────────────────────────────────────────────────

# Device A — runs the executor + Docker services
DEVICE_A="YOUR_DEVICE_IP"
DEVICE_A_USER="${DEVICE_A_USER:-YOUR_USER}"
AD4M_HOST="${AD4M_HOST:-$DEVICE_A}"
AD4M_PORT="${AD4M_PORT:-12000}"
AD4M_TOKEN="${AD4M_TOKEN:-test123}"

# Language addresses (installed on executor)
LANG_ATPROTO="QmzSYwdgzU4pEnJUebu7yrZucqRGSaTfKJs7NBMuFcZLL28xqEq"
LANG_MATRIX="QmzSYwdkxzhf4sCxuUH28xY6qCFb4xtEPxf4tSSrz8KNs3WUzAW"
LANG_SOLID="QmzSYwdq6o6am1uXnDU7BJ9GFxVFs5xUJLqFQd3ewar7NvSFi8f"
LANG_IPFS="QmzSYwdiVKeuFLdJSLNndi4Gpjegp1DATGrfyCphXxYYHd4gfRf"
LANG_NOSTR="QmzSYwdoGhjYy5u7kQwRtv9GZy9U6y66GrdCWaEfk7zQDM3yMsW"
LANG_HYPERCORE="QmzSYwdpq92UgzvHHBAsHTC6jRHkBf7y74DaLmrAWnb8XUtnMVH"

# Service endpoints (on Device A)
MATRIX_URL="http://${DEVICE_A}:6167"
ATPROTO_URL="http://${DEVICE_A}:2583"
SOLID_URL="http://${DEVICE_A}:3000"
IPFS_API="http://${DEVICE_A}:5001"
IPFS_GATEWAY="http://${DEVICE_A}:8080"
NOSTR_WS="ws://${DEVICE_A}:7777"
HYPERCORE_URL="http://${DEVICE_A}:7778"

# Test data prefix — unique per run to avoid collisions
RUN_ID="interop-$(date +%s)"

# ─── Results tracking ────────────────────────────────────────────────────────

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TEST_NAME=""

pass() {
    local name="$1" detail="${2:-}"
    ((PASS_COUNT++)) || true
    echo -e "  ${GREEN}✅ PASS:${NC} ${name}${detail:+ — $detail}"
}

fail() {
    local name="$1" detail="${2:-}"
    ((FAIL_COUNT++)) || true
    echo -e "  ${RED}❌ FAIL:${NC} ${name}${detail:+ — $detail}"
}

skip() {
    local name="$1" reason="${2:-}"
    ((SKIP_COUNT++)) || true
    echo -e "  ${YELLOW}⏭️  SKIP:${NC} ${name}${reason:+ — $reason}"
}

print_summary() {
    local protocol="$1"
    echo ""
    echo -e "${BOLD}═══ ${protocol} Interop Summary ═══${NC}"
    echo -e "  ${GREEN}Passed:${NC}  $PASS_COUNT"
    echo -e "  ${RED}Failed:${NC}  $FAIL_COUNT"
    echo -e "  ${YELLOW}Skipped:${NC} $SKIP_COUNT"
    echo ""
    if [[ $FAIL_COUNT -gt 0 ]]; then
        echo -e "  ${RED}${BOLD}OVERALL: FAIL${NC}"
        return 1
    else
        echo -e "  ${GREEN}${BOLD}OVERALL: PASS${NC}"
        return 0
    fi
}

# ─── SSH helpers ─────────────────────────────────────────────────────────────

ssh_device_a() {
    ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
        "${DEVICE_A_USER}@${DEVICE_A}" "$@"
}

# ─── AD4M RPC helpers ───────────────────────────────────────────────────────

ad4m_rpc() {
    python3 "$AD4M_RPC" --host "$AD4M_HOST" --port "$AD4M_PORT" --token "$AD4M_TOKEN" "$@"
}

# Wait for the executor to be reachable
wait_executor() {
    local timeout="${1:-30}"
    step "Waiting for executor at ${AD4M_HOST}:${AD4M_PORT}..."
    if ad4m_rpc wait-ready --timeout "$timeout" >/dev/null 2>&1; then
        success "Executor ready"
        return 0
    fi
    error "Executor at ${AD4M_HOST}:${AD4M_PORT} not ready after ${timeout}s"
    return 1
}

# ─── Language / perspective / neighbourhood operations ───────────────────────

# Apply a language template and return the new language address
# Usage: publish_and_configure_language SOURCE_HASH TEMPLATE_DATA_JSON
publish_and_configure_language() {
    local source_hash="$1" template_json="$2"
    step "Applying template for language ${source_hash}..."
    local result
    result=$(ad4m_rpc language-apply-template "$source_hash" "$template_json" 2>/dev/null)
    local new_addr
    new_addr=$(echo "$result" | jq -r '.address // empty' 2>/dev/null)
    if [[ -z "$new_addr" ]]; then
        # Some responses return the address as a direct string
        new_addr=$(echo "$result" | jq -r '. // empty' 2>/dev/null)
    fi
    if [[ -z "$new_addr" || "$new_addr" == "null" ]]; then
        error "Failed to apply language template"
        echo "  Response: $result" >&2
        return 1
    fi
    info "Configured language: $new_addr"
    echo "$new_addr"
}

# Create a perspective and return its UUID
# Usage: create_test_perspective NAME
create_test_perspective() {
    local name="$1"
    step "Creating perspective '$name'..."
    local result
    result=$(ad4m_rpc perspective-create "$name" 2>/dev/null)
    local uuid
    uuid=$(echo "$result" | jq -r '.uuid // empty' 2>/dev/null)
    if [[ -z "$uuid" || "$uuid" == "null" ]]; then
        error "Failed to create perspective"
        echo "  Response: $result" >&2
        return 1
    fi
    info "Created perspective: $uuid"
    echo "$uuid"
}

# Publish a perspective as neighbourhood and return the neighbourhood URL
# Usage: create_test_neighbourhood PERSPECTIVE_UUID LINK_LANGUAGE_ADDRESS
create_test_neighbourhood() {
    local uuid="$1" lang_addr="$2"
    step "Publishing neighbourhood (perspective: $uuid, language: $lang_addr)..."
    local result
    result=$(ad4m_rpc neighbourhood-publish "$uuid" "$lang_addr" 2>/dev/null)
    local url
    if echo "$result" | jq -e 'type == "string"' >/dev/null 2>&1; then
        url=$(echo "$result" | jq -r '.')
    else
        url=$(echo "$result" | jq -r '.url // .neighbourhoodUrl // empty' 2>/dev/null)
    fi
    if [[ -z "$url" || "$url" == "null" ]]; then
        error "Failed to create neighbourhood"
        echo "  Response: $result" >&2
        return 1
    fi
    info "Neighbourhood URL: $url"
    echo "$url"
}

# Add test links to a perspective
# Usage: add_test_links PERSPECTIVE_UUID [PREFIX]
# Adds 3 links with the given prefix (default: $RUN_ID)
add_test_links() {
    local uuid="$1" prefix="${2:-$RUN_ID}"
    step "Adding 3 test links to perspective $uuid..."
    ad4m_rpc perspective-add-link "$uuid" \
        "ad4m://test/${prefix}/subject-1" \
        "ad4m://test/${prefix}/object-1" \
        "ad4m://test/${prefix}/predicate-knows" >/dev/null
    ad4m_rpc perspective-add-link "$uuid" \
        "ad4m://test/${prefix}/subject-2" \
        "ad4m://test/${prefix}/object-2" \
        "ad4m://test/${prefix}/predicate-has" >/dev/null
    ad4m_rpc perspective-add-link "$uuid" \
        "ad4m://test/${prefix}/subject-3" \
        "ad4m://test/${prefix}/object-3" \
        "ad4m://test/${prefix}/predicate-links" >/dev/null
    info "Added 3 test links"
}

# Query all links from a perspective
# Usage: query_test_links PERSPECTIVE_UUID
query_test_links() {
    local uuid="$1"
    ad4m_rpc perspective-query-links "$uuid"
}

# Trigger a sync on the perspective (raw RPC)
# Usage: trigger_sync PERSPECTIVE_UUID
trigger_sync() {
    local uuid="$1"
    step "Triggering sync on perspective $uuid..."
    # Use raw RPC to call perspective.sync if available, otherwise just re-query
    ad4m_rpc raw "perspective.pullLinks" "{\"uuid\": \"$uuid\"}" 2>/dev/null || true
    sleep 2
}

# Cleanup: remove a perspective
cleanup_perspective() {
    local uuid="$1"
    if [[ -n "$uuid" && "$uuid" != "null" ]]; then
        step "Removing perspective $uuid..."
        ad4m_rpc perspective-remove "$uuid" >/dev/null 2>&1 || true
    fi
}

# ─── Health checks ───────────────────────────────────────────────────────────

check_http() {
    local url="$1" name="$2" timeout="${3:-10}"
    step "Checking $name at $url..."
    if curl -sf --max-time "$timeout" "$url" >/dev/null 2>&1; then
        success "$name is reachable"
        return 0
    fi
    error "$name is not reachable at $url"
    return 1
}

check_ws() {
    local host="$1" port="$2" name="$3" timeout="${4:-5}"
    step "Checking $name at $host:$port..."
    if nc -z -w"$timeout" "$host" "$port" 2>/dev/null; then
        success "$name WebSocket port is open"
        return 0
    fi
    error "$name WebSocket port is not open at $host:$port"
    return 1
}

check_docker_service() {
    local container="$1" name="$2"
    step "Checking Docker container '$container' on Device A..."
    local status
    status=$(ssh_device_a "docker inspect -f '{{.State.Status}}' $container 2>/dev/null" 2>/dev/null) || true
    if [[ "$status" == "running" ]]; then
        success "$name container is running"
        return 0
    fi
    error "$name container is not running (status: ${status:-not found})"
    return 1
}
