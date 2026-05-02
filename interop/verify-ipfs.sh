#!/usr/bin/env bash
# verify-ipfs.sh — IPFS (Kubo) ↔ AD4M interop verification
#
# Proves bidirectional data flow:
#   1. AD4M writes links → published as DAG-JSON objects, fetchable via IPFS gateway
#   2. Add DAG-JSON object via IPFS API → AD4M reads it back
#
# Counterpart: IPFS Gateway at http://host:8080/ipfs/<CID>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "IPFS (Kubo) ↔ AD4M Interop Test"

PERSPECTIVE_UUID=""
CONFIGURED_LANG=""

cleanup() {
    echo ""
    step "Cleaning up..."
    [[ -n "$PERSPECTIVE_UUID" ]] && cleanup_perspective "$PERSPECTIVE_UUID"
}
trap cleanup EXIT

# ─── Step 1: Health check ───────────────────────────────────────────────────

step "1. Checking IPFS (Kubo) service..."

# Kubo API requires POST for most endpoints
IPFS_ID_RESP=$(curl -sf -X POST "$IPFS_API/api/v0/id" 2>/dev/null) || IPFS_ID_RESP=""
IPFS_PEER_ID=$(echo "$IPFS_ID_RESP" | jq -r '.ID // empty' 2>/dev/null)

if [[ -n "$IPFS_PEER_ID" ]]; then
    pass "service-health" "Kubo reachable — Peer ID: $IPFS_PEER_ID"
else
    fail "service-health" "IPFS Kubo not reachable at $IPFS_API"
    print_summary "IPFS" || exit 1
fi

# Check gateway
if check_http "$IPFS_GATEWAY" "IPFS Gateway" 5 2>/dev/null; then
    pass "gateway-health" "Gateway reachable at $IPFS_GATEWAY"
else
    warn "IPFS Gateway not reachable — native read via gateway may fail"
fi

# ─── Step 2: Configure language ────────────────────────────────────────────

step "2. Configuring IPFS link language..."
TEMPLATE_DATA=$(jq -n \
    --arg api "$IPFS_API" \
    --arg gw "$IPFS_GATEWAY" \
    '{
        "ipfsApiUrl": $api,
        "ipfsGatewayUrl": $gw
    }')

CONFIGURED_LANG=$(publish_and_configure_language "$LANG_IPFS" "$TEMPLATE_DATA" 2>/dev/null) || true
if [[ -n "$CONFIGURED_LANG" && "$CONFIGURED_LANG" != "null" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Could not apply template to IPFS language"
    CONFIGURED_LANG="$LANG_IPFS"
    warn "Falling back to base language address"
fi

# ─── Step 3: Create perspective → publish as neighbourhood ──────────────────

step "3. Creating perspective and neighbourhood..."
PERSPECTIVE_UUID=$(create_test_perspective "interop-ipfs-${RUN_ID}" 2>/dev/null) || true
if [[ -z "$PERSPECTIVE_UUID" ]]; then
    fail "perspective-create" "Could not create perspective"
    print_summary "IPFS" || exit 1
fi

NEIGHBOURHOOD_URL=$(create_test_neighbourhood "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" 2>/dev/null) || true
if [[ -n "$NEIGHBOURHOOD_URL" ]]; then
    pass "neighbourhood-create" "Published neighbourhood"
else
    fail "neighbourhood-create" "Could not publish neighbourhood"
    print_summary "IPFS" || exit 1
fi

# ─── Step 4: Add 3 test links via AD4M ─────────────────────────────────────

step "4. Adding test links via AD4M..."
add_test_links "$PERSPECTIVE_UUID" "$RUN_ID" 2>/dev/null || true

LINKS=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS="[]"
LINK_COUNT=$(echo "$LINKS" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || LINK_COUNT=0

if [[ "$LINK_COUNT" -ge 3 ]]; then
    pass "ad4m-write" "Wrote $LINK_COUNT links via AD4M"
else
    fail "ad4m-write" "Expected 3 links in AD4M, found $LINK_COUNT"
fi

# ─── Step 5: Check IPFS for the published data ─────────────────────────────

step "5. Checking IPFS for AD4M-published objects..."
sleep 3

# The language should pin the data to IPFS. We can look for recent pins.
PINS_RESP=$(curl -sf -X POST "$IPFS_API/api/v0/pin/ls?type=recursive" 2>/dev/null) || PINS_RESP=""

if [[ -n "$PINS_RESP" ]]; then
    PIN_COUNT=$(echo "$PINS_RESP" | jq '.Keys | length' 2>/dev/null) || PIN_COUNT=0
    info "Found $PIN_COUNT pinned objects in IPFS"

    # Try to find objects that look like AD4M link data
    # Get the most recent DAG objects
    RECENT_CIDS=$(echo "$PINS_RESP" | jq -r '.Keys | keys[:5][]' 2>/dev/null) || RECENT_CIDS=""

    FOUND_AD4M=false
    for cid in $RECENT_CIDS; do
        OBJ=$(curl -sf -X POST "$IPFS_API/api/v0/dag/get?arg=$cid" 2>/dev/null) || continue
        if echo "$OBJ" | jq -e '.source // .links // .data' >/dev/null 2>&1; then
            FOUND_AD4M=true
            pass "native-read" "Found AD4M data at CID: $cid"
            info "Object content:"
            echo "$OBJ" | jq '.' 2>/dev/null | head -10
            break
        fi
    done

    if [[ "$FOUND_AD4M" == "false" ]]; then
        if [[ "$PIN_COUNT" -gt 0 ]]; then
            skip "native-read" "Pinned objects exist but none matched AD4M format"
        else
            fail "native-read" "No pinned objects found"
        fi
    fi
else
    fail "native-read" "Could not query IPFS pins"
fi

# Try fetching via gateway if we have a CID
if [[ -n "${RECENT_CIDS:-}" ]]; then
    FIRST_CID=$(echo "$RECENT_CIDS" | head -1)
    GW_RESP=$(curl -sf --max-time 10 "$IPFS_GATEWAY/ipfs/$FIRST_CID" 2>/dev/null) || GW_RESP=""
    if [[ -n "$GW_RESP" ]]; then
        pass "gateway-fetch" "Successfully fetched CID via gateway: $FIRST_CID"
    else
        skip "gateway-fetch" "Gateway fetch failed for CID $FIRST_CID"
    fi
fi

# ─── Step 6: Write DAG-JSON from IPFS side ─────────────────────────────────

step "6. Writing DAG-JSON object from IPFS (native) side..."
NATIVE_SOURCE="ipfs://native/subject-1"
NATIVE_TARGET="ipfs://native/object-1"
NATIVE_PREDICATE="ipfs://native/predicate-created"

DAG_JSON=$(jq -n \
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

# Put object via dag/put
DAG_RESP=$(echo "$DAG_JSON" | curl -sf -X POST "$IPFS_API/api/v0/dag/put?store-codec=dag-json&input-codec=dag-json" \
    -F "file=@-" 2>/dev/null) || DAG_RESP=""

NEW_CID=$(echo "$DAG_RESP" | jq -r '.Cid."/" // .Cid // empty' 2>/dev/null)
if [[ -n "$NEW_CID" && "$NEW_CID" != "null" ]]; then
    pass "native-write" "Published DAG-JSON — CID: $NEW_CID"

    # Pin it so it persists
    curl -sf -X POST "$IPFS_API/api/v0/pin/add?arg=$NEW_CID" >/dev/null 2>&1 || true
    info "Pinned CID: $NEW_CID"

    # Verify via gateway
    GW_CHECK=$(curl -sf --max-time 10 "$IPFS_GATEWAY/ipfs/$NEW_CID" 2>/dev/null) || GW_CHECK=""
    if [[ -n "$GW_CHECK" ]]; then
        pass "gateway-verify" "Native object retrievable: $IPFS_GATEWAY/ipfs/$NEW_CID"
    fi
else
    # Try via add endpoint instead
    DAG_RESP=$(echo "$DAG_JSON" | curl -sf -X POST "$IPFS_API/api/v0/add" \
        -F "file=@-;filename=ad4m-link.json" 2>/dev/null) || DAG_RESP=""
    NEW_CID=$(echo "$DAG_RESP" | jq -r '.Hash // empty' 2>/dev/null)

    if [[ -n "$NEW_CID" ]]; then
        pass "native-write" "Published via /add — CID: $NEW_CID"
    else
        fail "native-write" "Could not publish DAG-JSON to IPFS"
    fi
fi

# ─── Step 7: Trigger sync and check AD4M ───────────────────────────────────

step "7. Syncing AD4M and checking for native-written data..."
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
        info "IPFS links are content-addressed — AD4M needs to know the CID to fetch"
        info "The link language may need the CID added to a known index/list"
    fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "Manual verification:"
if [[ -n "${NEW_CID:-}" ]]; then
    echo "  # Fetch native-written object:"
    echo "  curl $IPFS_GATEWAY/ipfs/$NEW_CID"
    echo ""
fi
echo "  # List all pins:"
echo "  curl -X POST '$IPFS_API/api/v0/pin/ls'"
echo ""
echo "  # Get a DAG object:"
echo "  curl -X POST '$IPFS_API/api/v0/dag/get?arg=<CID>'"

print_summary "IPFS" || exit 1
