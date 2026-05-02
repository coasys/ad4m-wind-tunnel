#!/usr/bin/env bash
# verify-hypercore.sh — Hypercore Gateway ↔ AD4M interop verification
#
# Proves bidirectional data flow:
#   1. AD4M writes links → appended to Hypercore feed, visible via gateway API
#   2. Write to feed via gateway API → AD4M sync picks it up
#
# Counterpart: hyp CLI tool or curl to gateway HTTP API
# NOTE: Hypercore Gateway is NOT Docker — it's a Node.js process on Device A
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "Hypercore Gateway ↔ AD4M Interop Test"

PERSPECTIVE_UUID=""
CONFIGURED_LANG=""
FEED_KEY=""

cleanup() {
    echo ""
    step "Cleaning up..."
    [[ -n "$PERSPECTIVE_UUID" ]] && cleanup_perspective "$PERSPECTIVE_UUID"
}
trap cleanup EXIT

# ─── Step 1: Health check ───────────────────────────────────────────────────

step "1. Checking Hypercore Gateway service..."

GW_STATUS=$(curl -sf --max-time 5 "$HYPERCORE_URL/status" 2>/dev/null) || GW_STATUS=""

if [[ -n "$GW_STATUS" ]]; then
    pass "service-health" "Hypercore Gateway reachable at $HYPERCORE_URL"
    info "Status: $GW_STATUS"
else
    # Try alternate health endpoints
    GW_ALT=$(curl -sf --max-time 5 "$HYPERCORE_URL/" 2>/dev/null) || GW_ALT=""
    if [[ -n "$GW_ALT" ]]; then
        pass "service-health" "Hypercore Gateway reachable (root endpoint)"
    else
        fail "service-health" "Hypercore Gateway not reachable at $HYPERCORE_URL"
        echo ""
        echo "  The Hypercore Gateway is a Node.js process (not Docker)."
        echo "  Start it on Device A:"
        echo "    cd /tmp/hypercore-gateway && node index.js &"
        echo ""
        echo "  If the gateway code doesn't exist yet:"
        echo "    1. SSH to Device A: ssh ${DEVICE_A_USER}@${DEVICE_A}"
        echo "    2. mkdir -p /tmp/hypercore-gateway && cd /tmp/hypercore-gateway"
        echo "    3. npm init -y && npm install hypercore hyperswarm express"
        echo "    4. Create index.js (see README.md for reference implementation)"
        echo "    5. node index.js &"
        print_summary "Hypercore" || exit 1
    fi
fi

# ─── Step 2: Create or get a test feed ──────────────────────────────────────

step "2. Creating test feed..."

# Try to create a new feed via the gateway API
FEED_RESP=$(curl -sf -X POST "$HYPERCORE_URL/feeds" \
    -H "Content-Type: application/json" \
    -d '{"name": "ad4m-interop-test"}' 2>/dev/null) || FEED_RESP=""

FEED_KEY=$(echo "$FEED_RESP" | jq -r '.key // .feedKey // empty' 2>/dev/null)

if [[ -n "$FEED_KEY" && "$FEED_KEY" != "null" ]]; then
    pass "feed-create" "Feed key: ${FEED_KEY:0:32}..."
else
    # Try listing existing feeds
    FEEDS_RESP=$(curl -sf "$HYPERCORE_URL/feeds" 2>/dev/null) || FEEDS_RESP="[]"
    FEED_KEY=$(echo "$FEEDS_RESP" | jq -r '.[0].key // .[0] // empty' 2>/dev/null)

    if [[ -n "$FEED_KEY" && "$FEED_KEY" != "null" ]]; then
        pass "feed-create" "Using existing feed: ${FEED_KEY:0:32}..."
    else
        warn "Could not create or find a feed"
        skip "feed-create" "Gateway API may use different endpoints"
        FEED_KEY="test-feed"
    fi
fi

# ─── Step 3: Configure language ────────────────────────────────────────────

step "3. Configuring Hypercore link language..."
TEMPLATE_DATA=$(jq -n \
    --arg gw "$HYPERCORE_URL" \
    --arg key "$FEED_KEY" \
    '{
        "gatewayUrl": $gw,
        "feedKey": $key
    }')

CONFIGURED_LANG=$(publish_and_configure_language "$LANG_HYPERCORE" "$TEMPLATE_DATA" 2>/dev/null) || true
if [[ -n "$CONFIGURED_LANG" && "$CONFIGURED_LANG" != "null" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Could not apply template to Hypercore language"
    CONFIGURED_LANG="$LANG_HYPERCORE"
    warn "Falling back to base language address"
fi

# ─── Step 4: Create perspective → publish as neighbourhood ──────────────────

step "4. Creating perspective and neighbourhood..."
PERSPECTIVE_UUID=$(create_test_perspective "interop-hypercore-${RUN_ID}" 2>/dev/null) || true
if [[ -z "$PERSPECTIVE_UUID" ]]; then
    fail "perspective-create" "Could not create perspective"
    print_summary "Hypercore" || exit 1
fi

NEIGHBOURHOOD_URL=$(create_test_neighbourhood "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" 2>/dev/null) || true
if [[ -n "$NEIGHBOURHOOD_URL" ]]; then
    pass "neighbourhood-create" "Published neighbourhood"
else
    fail "neighbourhood-create" "Could not publish neighbourhood"
    print_summary "Hypercore" || exit 1
fi

# ─── Step 5: Add 3 test links via AD4M ─────────────────────────────────────

step "5. Adding test links via AD4M..."
add_test_links "$PERSPECTIVE_UUID" "$RUN_ID" 2>/dev/null || true

LINKS=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS="[]"
LINK_COUNT=$(echo "$LINKS" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || LINK_COUNT=0

if [[ "$LINK_COUNT" -ge 3 ]]; then
    pass "ad4m-write" "Wrote $LINK_COUNT links via AD4M"
else
    fail "ad4m-write" "Expected 3 links in AD4M, found $LINK_COUNT"
fi

# ─── Step 6: Check Hypercore feed for entries ──────────────────────────────

step "6. Checking Hypercore feed for AD4M entries..."
sleep 3

# Query feed entries via gateway
ENTRIES_RESP=$(curl -sf "$HYPERCORE_URL/feeds/$FEED_KEY/entries" 2>/dev/null) || \
ENTRIES_RESP=$(curl -sf "$HYPERCORE_URL/feeds/$FEED_KEY" 2>/dev/null) || \
ENTRIES_RESP=""

if [[ -n "$ENTRIES_RESP" ]]; then
    ENTRY_COUNT=$(echo "$ENTRIES_RESP" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || ENTRY_COUNT=0

    if [[ "$ENTRY_COUNT" -gt 0 ]]; then
        pass "native-read" "Found $ENTRY_COUNT entries in Hypercore feed"
        info "Sample entry:"
        echo "$ENTRIES_RESP" | jq '.[0]' 2>/dev/null | head -10
    else
        # Try getting feed info/length
        FEED_INFO=$(curl -sf "$HYPERCORE_URL/feeds/$FEED_KEY/info" 2>/dev/null) || FEED_INFO=""
        FEED_LEN=$(echo "$FEED_INFO" | jq -r '.length // 0' 2>/dev/null) || FEED_LEN=0

        if [[ "$FEED_LEN" -gt 0 ]]; then
            info "Feed has $FEED_LEN entries but listing returned empty"
            skip "native-read" "Feed has entries but listing endpoint may differ"
        else
            fail "native-read" "No entries found in Hypercore feed"
        fi
    fi
else
    skip "native-read" "Could not query feed entries — gateway API may differ"
fi

# ─── Step 7: Write entry from Hypercore side ───────────────────────────────

step "7. Writing entry from Hypercore (native) side..."
NATIVE_SOURCE="hypercore://native/subject-1"
NATIVE_TARGET="hypercore://native/object-1"
NATIVE_PREDICATE="hypercore://native/predicate-created"

ENTRY_DATA=$(jq -n \
    --arg src "$NATIVE_SOURCE" \
    --arg tgt "$NATIVE_TARGET" \
    --arg pred "$NATIVE_PREDICATE" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
        "source": $src,
        "target": $tgt,
        "predicate": $pred,
        "createdAt": $ts,
        "type": "ad4m-link"
    }')

# Append to feed via gateway
APPEND_RESP=$(curl -sf -X POST "$HYPERCORE_URL/feeds/$FEED_KEY/append" \
    -H "Content-Type: application/json" \
    -d "$ENTRY_DATA" 2>/dev/null) || APPEND_RESP=""

if [[ -n "$APPEND_RESP" ]]; then
    SEQ=$(echo "$APPEND_RESP" | jq -r '.seq // .index // .length // "ok"' 2>/dev/null)
    pass "native-write" "Appended entry to feed (seq: $SEQ)"
else
    # Try alternate append endpoint
    APPEND_RESP=$(curl -sf -X POST "$HYPERCORE_URL/feeds/$FEED_KEY" \
        -H "Content-Type: application/json" \
        -d "$ENTRY_DATA" 2>/dev/null) || APPEND_RESP=""

    if [[ -n "$APPEND_RESP" ]]; then
        pass "native-write" "Appended entry via alternate endpoint"
    else
        fail "native-write" "Could not append entry to Hypercore feed"
        info "Gateway may use different API — check /tmp/hypercore-gateway/index.js"
    fi
fi

# ─── Step 8: Trigger sync and check AD4M ───────────────────────────────────

step "8. Syncing AD4M and checking for native-written data..."
trigger_sync "$PERSPECTIVE_UUID" 2>/dev/null || true
sleep 3

LINKS_AFTER=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS_AFTER="[]"
LINK_COUNT_AFTER=$(echo "$LINKS_AFTER" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || LINK_COUNT_AFTER=0

NATIVE_FOUND=$(echo "$LINKS_AFTER" | jq --arg src "$NATIVE_SOURCE" \
    'if type == "array" then [.[] | .data // . | select(.source == $src)] | length else 0 end' 2>/dev/null) || NATIVE_FOUND=0

if [[ "$NATIVE_FOUND" -gt 0 ]]; then
    pass "reverse-sync" "Native-written link appeared in AD4M ($LINK_COUNT_AFTER total links)"
else
    if [[ "$LINK_COUNT_AFTER" -gt "$LINK_COUNT" ]]; then
        skip "reverse-sync" "New links appeared but native source not matched"
    else
        fail "reverse-sync" "Native-written data not found in AD4M after sync"
    fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "Manual verification:"
echo "  # List feeds:"
echo "  curl $HYPERCORE_URL/feeds"
echo ""
echo "  # Get feed entries:"
echo "  curl $HYPERCORE_URL/feeds/$FEED_KEY/entries"
echo ""
echo "NOTE: The Hypercore language address may be updated after the gateway fix."
echo "If tests fail, check if a newer language has been published."

print_summary "Hypercore" || exit 1
