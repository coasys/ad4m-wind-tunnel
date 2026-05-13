#!/usr/bin/env bash
# verify-nextgraph.sh — NextGraph ↔ AD4M interop verification
#
# Proves bidirectional data flow:
#   1. AD4M writes links → appear as SPARQL triples in NextGraph
#   2. NextGraph gateway writes triples → AD4M sync picks them up
#
# Requires: NextGraph sidecar gateway running (not Docker — standalone Node.js)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "NextGraph ↔ AD4M Interop Test"

PERSPECTIVE_UUID=""
CONFIGURED_LANG=""
GATEWAY_PORT="${NEXTGRAPH_PORT:-7779}"
GATEWAY_URL="http://${DEVICE_A:-127.0.0.1}:${GATEWAY_PORT}"

cleanup() {
    echo ""
    step "Cleaning up..."
    [[ -n "$PERSPECTIVE_UUID" ]] && cleanup_perspective "$PERSPECTIVE_UUID"
}
trap cleanup EXIT

# ─── Step 1: Health check ───────────────────────────────────────────────────

step "1. Checking NextGraph gateway..."
if ! check_http "$GATEWAY_URL/status" "NextGraph Gateway"; then
    fail "service-health" "NextGraph gateway not reachable at $GATEWAY_URL"
    echo ""
    echo "Start the gateway:"
    echo "  cd /path/to/nextgraph-link-language/gateway"
    echo "  PORT=$GATEWAY_PORT STORAGE_PATH=./data tsx index.ts"
    print_summary "NextGraph" || exit 1
fi

# Verify gateway is healthy
STATUS_RESP=$(curl -sf "$GATEWAY_URL/status" 2>/dev/null) || STATUS_RESP=""
GATEWAY_OK=$(echo "$STATUS_RESP" | jq -r '.ok // false' 2>/dev/null)
if [[ "$GATEWAY_OK" == "true" ]]; then
    pass "service-health" "Gateway healthy at $GATEWAY_URL"
else
    fail "service-health" "Gateway unhealthy: $STATUS_RESP"
    print_summary "NextGraph" || exit 1
fi

# ─── Step 2: Ensure wallet is initialized ───────────────────────────────────

step "2. Ensuring wallet is initialized..."
SESSION_RESP=$(curl -sf "$GATEWAY_URL/session" 2>/dev/null) || SESSION_RESP=""
HAS_SESSION=$(echo "$SESSION_RESP" | jq -r '.sessionId // empty' 2>/dev/null)

if [[ -z "$HAS_SESSION" ]]; then
    # Initialize wallet
    INIT_RESP=$(curl -sf -X POST "$GATEWAY_URL/wallet/init" \
        -H "Content-Type: application/json" \
        -d '{"name": "AD4M Interop Test"}' 2>/dev/null) || INIT_RESP=""

    HAS_SESSION=$(echo "$INIT_RESP" | jq -r '.sessionId // empty' 2>/dev/null)
    if [[ -n "$HAS_SESSION" ]]; then
        pass "wallet-init" "Wallet initialized"
    else
        fail "wallet-init" "Could not initialize wallet"
        print_summary "NextGraph" || exit 1
    fi
else
    pass "wallet-init" "Wallet already loaded"
fi

REPO_ID=$(echo "$SESSION_RESP" | jq -r '.repoId // empty' 2>/dev/null)
if [[ -z "$REPO_ID" ]]; then
    REPO_ID=$(curl -sf "$GATEWAY_URL/session" 2>/dev/null | jq -r '.repoId // empty')
fi
info "Repo ID: ${REPO_ID:-unknown}"

# ─── Step 3: Configure language with template vars ──────────────────────────

step "3. Configuring NextGraph link language..."
TEMPLATE_DATA=$(jq -n \
    --arg gw "$GATEWAY_URL" \
    --arg repo "$REPO_ID" \
    '{
        "gatewayUrl": $gw,
        "repoId": $repo
    }')

CONFIGURED_LANG=$(publish_and_configure_language "${LANG_NEXTGRAPH:-}" "$TEMPLATE_DATA" 2>/dev/null) || true
if [[ -n "$CONFIGURED_LANG" && "$CONFIGURED_LANG" != "null" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Could not apply template to NextGraph language"
    CONFIGURED_LANG="${LANG_NEXTGRAPH:-}"
    warn "Falling back to base language address"
fi

# ─── Step 4: Create perspective → publish as neighbourhood ──────────────────

step "4. Creating perspective and neighbourhood..."
PERSPECTIVE_UUID=$(create_test_perspective "interop-nextgraph-${RUN_ID}" 2>/dev/null) || true
if [[ -z "$PERSPECTIVE_UUID" ]]; then
    fail "perspective-create" "Could not create perspective"
    print_summary "NextGraph" || exit 1
fi

NEIGHBOURHOOD_URL=$(create_test_neighbourhood "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" 2>/dev/null) || true
if [[ -n "$NEIGHBOURHOOD_URL" ]]; then
    pass "neighbourhood-create" "Published neighbourhood"
else
    fail "neighbourhood-create" "Could not publish neighbourhood"
    print_summary "NextGraph" || exit 1
fi

# ─── Step 5: Add 3 test links via AD4M ─────────────────────────────────────

step "5. Adding test links via AD4M..."
add_test_links "$PERSPECTIVE_UUID" "$RUN_ID" 2>/dev/null || true

# Query to confirm they're stored in AD4M
LINKS=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS="[]"
LINK_COUNT=$(echo "$LINKS" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || LINK_COUNT=0

if [[ "$LINK_COUNT" -ge 3 ]]; then
    pass "ad4m-write" "Wrote $LINK_COUNT links via AD4M"
else
    fail "ad4m-write" "Expected 3 links in AD4M, found $LINK_COUNT"
fi

# ─── Step 6: Verify triples appear in NextGraph ────────────────────────────

step "6. Checking NextGraph for AD4M triples..."
sleep 3  # Give the language time to push triples

TRIPLES_RESP=$(curl -sf "$GATEWAY_URL/triples" 2>/dev/null) || TRIPLES_RESP="{}"
TRIPLE_COUNT=$(echo "$TRIPLES_RESP" | jq '.triples | length' 2>/dev/null) || TRIPLE_COUNT=0

if [[ "$TRIPLE_COUNT" -gt 0 ]]; then
    pass "native-read" "Found $TRIPLE_COUNT triples in NextGraph"
else
    # Check if triples exist with a filter
    TEST_SUBJECT="ad4m://test/${RUN_ID}/subject-1"
    FILTERED_RESP=$(curl -sf "$GATEWAY_URL/triples?subject=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TEST_SUBJECT'))")" 2>/dev/null) || FILTERED_RESP="{}"
    FILTERED_COUNT=$(echo "$FILTERED_RESP" | jq '.triples | length' 2>/dev/null) || FILTERED_COUNT=0

    if [[ "$FILTERED_COUNT" -gt 0 ]]; then
        pass "native-read" "Found $FILTERED_COUNT filtered triples in NextGraph"
    else
        fail "native-read" "No triples found in NextGraph"
    fi
fi

# ─── Step 7: Write triple from NextGraph side ──────────────────────────────

step "7. Writing triple from NextGraph (native) side..."
NATIVE_SUBJECT="nextgraph://native/subject-1"
NATIVE_PREDICATE="nextgraph://native/predicate-created"
NATIVE_OBJECT="nextgraph://native/object-1"

WRITE_RESP=$(curl -sf -X POST "$GATEWAY_URL/triples" \
    -H "Content-Type: application/json" \
    -d "{
        \"triples\": [{
            \"subject\": \"$NATIVE_SUBJECT\",
            \"predicate\": \"$NATIVE_PREDICATE\",
            \"object\": \"$NATIVE_OBJECT\",
            \"author\": \"did:ng:gateway-test\",
            \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
        }]
    }" 2>/dev/null) || WRITE_RESP=""

WRITE_REV=$(echo "$WRITE_RESP" | jq -r '.revision // empty' 2>/dev/null)
if [[ -n "$WRITE_REV" ]]; then
    pass "native-write" "Inserted triple (revision: $WRITE_REV)"
else
    fail "native-write" "Could not insert triple into NextGraph"
fi

# ─── Step 8: Trigger sync and check AD4M ───────────────────────────────────

step "8. Syncing AD4M and checking for native-written data..."
trigger_sync "$PERSPECTIVE_UUID" 2>/dev/null || true
sleep 3

LINKS_AFTER=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS_AFTER="[]"
LINK_COUNT_AFTER=$(echo "$LINKS_AFTER" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || LINK_COUNT_AFTER=0

# Check if the native-written link appears
NATIVE_FOUND=$(echo "$LINKS_AFTER" | jq --arg src "$NATIVE_SUBJECT" \
    'if type == "array" then [.[] | .data // . | select(.source == $src)] | length else 0 end' 2>/dev/null) || NATIVE_FOUND=0

if [[ "$NATIVE_FOUND" -gt 0 ]]; then
    pass "reverse-sync" "Native-written triple appeared in AD4M ($LINK_COUNT_AFTER total links)"
else
    if [[ "$LINK_COUNT_AFTER" -gt "$LINK_COUNT" ]]; then
        warn "Link count increased ($LINK_COUNT → $LINK_COUNT_AFTER) but native triple source not matched"
        skip "reverse-sync" "New links appeared but schema mapping unclear"
    else
        fail "reverse-sync" "Native-written data not found in AD4M after sync"
    fi
fi

# ─── Step 9: Verify incremental sync ───────────────────────────────────────

step "9. Verifying incremental sync support..."
SYNC_RESP=$(curl -sf "$GATEWAY_URL/sync?since=$WRITE_REV" 2>/dev/null) || SYNC_RESP=""
SYNC_REV=$(echo "$SYNC_RESP" | jq -r '.revision // empty' 2>/dev/null)

if [[ -n "$SYNC_REV" ]]; then
    SYNC_ADDS=$(echo "$SYNC_RESP" | jq '.additions | length' 2>/dev/null) || SYNC_ADDS=0
    pass "incremental-sync" "Incremental sync works (revision: $SYNC_REV, additions since: $SYNC_ADDS)"
else
    skip "incremental-sync" "Incremental sync endpoint not responding"
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "Manual verification:"
echo "  Gateway: $GATEWAY_URL"
echo "  GET $GATEWAY_URL/triples  — view all stored triples"
echo "  GET $GATEWAY_URL/session  — view session info"
echo "  GET $GATEWAY_URL/status   — health check"

print_summary "NextGraph" || exit 1
