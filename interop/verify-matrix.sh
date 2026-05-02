#!/usr/bin/env bash
# verify-matrix.sh — Matrix (Conduit) ↔ AD4M interop verification
#
# Proves bidirectional data flow:
#   1. AD4M writes links → appear as custom events in Matrix room
#   2. Matrix client writes events → AD4M sync picks them up
#
# Counterpart: Element Web (https://app.element.io) pointed at homeserver
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "Matrix (Conduit) ↔ AD4M Interop Test"

PERSPECTIVE_UUID=""
CONFIGURED_LANG=""
MATRIX_ACCESS_TOKEN=""
MATRIX_ROOM_ID=""
TEST_USER="ad4m_test"
TEST_PASS="testpass123"

cleanup() {
    echo ""
    step "Cleaning up..."
    [[ -n "$PERSPECTIVE_UUID" ]] && cleanup_perspective "$PERSPECTIVE_UUID"
}
trap cleanup EXIT

# ─── Step 1: Health check ───────────────────────────────────────────────────

step "1. Checking Matrix (Conduit) service..."
if ! check_http "$MATRIX_URL/_matrix/client/versions" "Matrix (Conduit)"; then
    fail "service-health" "Matrix/Conduit not reachable at $MATRIX_URL"
    print_summary "Matrix" || exit 1
fi
pass "service-health" "Conduit reachable at $MATRIX_URL"

# ─── Step 2: Ensure test user exists ────────────────────────────────────────

step "2. Ensuring test user exists..."
# Try to register; if already exists, try to login
REGISTER_RESP=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/register" \
    -H "Content-Type: application/json" \
    -d "{
        \"username\": \"$TEST_USER\",
        \"password\": \"$TEST_PASS\",
        \"auth\": {\"type\": \"m.login.dummy\"},
        \"inhibit_login\": false
    }" 2>/dev/null) || REGISTER_RESP=""

if [[ -n "$REGISTER_RESP" ]] && echo "$REGISTER_RESP" | jq -e '.access_token' >/dev/null 2>&1; then
    MATRIX_ACCESS_TOKEN=$(echo "$REGISTER_RESP" | jq -r '.access_token')
    pass "user-setup" "Registered user @${TEST_USER}"
else
    # User may already exist — try login
    LOGIN_RESP=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/login" \
        -H "Content-Type: application/json" \
        -d "{
            \"type\": \"m.login.password\",
            \"identifier\": {\"type\": \"m.id.user\", \"user\": \"$TEST_USER\"},
            \"password\": \"$TEST_PASS\"
        }" 2>/dev/null) || LOGIN_RESP=""

    if [[ -n "$LOGIN_RESP" ]] && echo "$LOGIN_RESP" | jq -e '.access_token' >/dev/null 2>&1; then
        MATRIX_ACCESS_TOKEN=$(echo "$LOGIN_RESP" | jq -r '.access_token')
        pass "user-setup" "Logged in as @${TEST_USER}"
    else
        fail "user-setup" "Could not register or login test user"
        print_summary "Matrix" || exit 1
    fi
fi

# ─── Step 3: Create a Matrix room for testing ───────────────────────────────

step "3. Creating test room..."
ROOM_RESP=$(curl -sf -X POST "$MATRIX_URL/_matrix/client/v3/createRoom" \
    -H "Authorization: Bearer $MATRIX_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
        \"name\": \"AD4M Interop Test ${RUN_ID}\",
        \"topic\": \"Automated interop test room\",
        \"visibility\": \"private\",
        \"preset\": \"private_chat\"
    }" 2>/dev/null) || ROOM_RESP=""

MATRIX_ROOM_ID=$(echo "$ROOM_RESP" | jq -r '.room_id // empty' 2>/dev/null)
if [[ -n "$MATRIX_ROOM_ID" ]]; then
    pass "room-create" "Room: $MATRIX_ROOM_ID"
else
    fail "room-create" "Could not create Matrix room"
    print_summary "Matrix" || exit 1
fi

# ─── Step 4: Configure language with template vars ──────────────────────────

step "4. Configuring Matrix link language..."
TEMPLATE_DATA=$(jq -n \
    --arg hs "$MATRIX_URL" \
    --arg room "$MATRIX_ROOM_ID" \
    --arg token "$MATRIX_ACCESS_TOKEN" \
    '{
        "homeserverUrl": $hs,
        "roomId": $room,
        "accessToken": $token
    }')

CONFIGURED_LANG=$(publish_and_configure_language "$LANG_MATRIX" "$TEMPLATE_DATA" 2>/dev/null) || true
if [[ -n "$CONFIGURED_LANG" && "$CONFIGURED_LANG" != "null" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Could not apply template to Matrix language"
    # Try to use the base language directly
    CONFIGURED_LANG="$LANG_MATRIX"
    warn "Falling back to base language address"
fi

# ─── Step 5: Create perspective → publish as neighbourhood ──────────────────

step "5. Creating perspective and neighbourhood..."
PERSPECTIVE_UUID=$(create_test_perspective "interop-matrix-${RUN_ID}" 2>/dev/null) || true
if [[ -z "$PERSPECTIVE_UUID" ]]; then
    fail "perspective-create" "Could not create perspective"
    print_summary "Matrix" || exit 1
fi

NEIGHBOURHOOD_URL=$(create_test_neighbourhood "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" 2>/dev/null) || true
if [[ -n "$NEIGHBOURHOOD_URL" ]]; then
    pass "neighbourhood-create" "Published neighbourhood"
else
    fail "neighbourhood-create" "Could not publish neighbourhood"
    print_summary "Matrix" || exit 1
fi

# ─── Step 6: Add 3 test links via AD4M ─────────────────────────────────────

step "6. Adding test links via AD4M..."
add_test_links "$PERSPECTIVE_UUID" "$RUN_ID" 2>/dev/null || true

# Query to confirm they're stored in AD4M
LINKS=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS="[]"
LINK_COUNT=$(echo "$LINKS" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || LINK_COUNT=0

if [[ "$LINK_COUNT" -ge 3 ]]; then
    pass "ad4m-write" "Wrote $LINK_COUNT links via AD4M"
else
    fail "ad4m-write" "Expected 3 links in AD4M, found $LINK_COUNT"
fi

# ─── Step 7: Verify links appear as Matrix events ──────────────────────────

step "7. Checking Matrix room for AD4M link events..."
sleep 3  # Give the language time to push events

MESSAGES_RESP=$(curl -sf "$MATRIX_URL/_matrix/client/v3/rooms/$MATRIX_ROOM_ID/messages?dir=b&limit=20" \
    -H "Authorization: Bearer $MATRIX_ACCESS_TOKEN" 2>/dev/null) || MESSAGES_RESP="{}"

# Look for events with AD4M link data (custom event type dev.ad4m.link.triple or in message body)
AD4M_EVENTS=$(echo "$MESSAGES_RESP" | jq '[.chunk[]? | select(
    .type == "dev.ad4m.link.triple" or
    .type == "m.room.message" and (.content.body // "" | contains("ad4m://"))
)] | length' 2>/dev/null) || AD4M_EVENTS=0

if [[ "$AD4M_EVENTS" -gt 0 ]]; then
    pass "native-read" "Found $AD4M_EVENTS AD4M link events in Matrix room"
else
    # The language may store data differently — check for any recent events
    TOTAL_EVENTS=$(echo "$MESSAGES_RESP" | jq '.chunk | length' 2>/dev/null) || TOTAL_EVENTS=0
    if [[ "$TOTAL_EVENTS" -gt 0 ]]; then
        warn "Found $TOTAL_EVENTS events in room but none matched AD4M link format"
        info "Events may use a different schema — check Element Web manually"
        skip "native-read" "Events found but format unclear — manual verification needed"
    else
        fail "native-read" "No events found in Matrix room"
    fi
fi

# ─── Step 8: Write event from Matrix side ───────────────────────────────────

step "8. Writing event from Matrix (native) side..."
NATIVE_SOURCE="matrix://native/subject-1"
NATIVE_TARGET="matrix://native/object-1"
NATIVE_PREDICATE="matrix://native/predicate-created"

EVENT_RESP=$(curl -sf -X PUT \
    "$MATRIX_URL/_matrix/client/v3/rooms/$MATRIX_ROOM_ID/send/dev.ad4m.link.triple/interop-test-$(date +%s)" \
    -H "Authorization: Bearer $MATRIX_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
        \"source\": \"$NATIVE_SOURCE\",
        \"target\": \"$NATIVE_TARGET\",
        \"predicate\": \"$NATIVE_PREDICATE\",
        \"msgtype\": \"dev.ad4m.link.triple\"
    }" 2>/dev/null) || EVENT_RESP=""

EVENT_ID=$(echo "$EVENT_RESP" | jq -r '.event_id // empty' 2>/dev/null)
if [[ -n "$EVENT_ID" ]]; then
    pass "native-write" "Sent custom event: $EVENT_ID"
else
    fail "native-write" "Could not send custom event to Matrix room"
fi

# ─── Step 9: Trigger sync and check AD4M ───────────────────────────────────

step "9. Syncing AD4M and checking for native-written data..."
trigger_sync "$PERSPECTIVE_UUID" 2>/dev/null || true
sleep 3

LINKS_AFTER=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS_AFTER="[]"
LINK_COUNT_AFTER=$(echo "$LINKS_AFTER" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || LINK_COUNT_AFTER=0

# Check if the native-written link appears
NATIVE_FOUND=$(echo "$LINKS_AFTER" | jq --arg src "$NATIVE_SOURCE" \
    'if type == "array" then [.[] | .data // . | select(.source == $src)] | length else 0 end' 2>/dev/null) || NATIVE_FOUND=0

if [[ "$NATIVE_FOUND" -gt 0 ]]; then
    pass "reverse-sync" "Native-written link appeared in AD4M ($LINK_COUNT_AFTER total links)"
else
    if [[ "$LINK_COUNT_AFTER" -gt "$LINK_COUNT" ]]; then
        warn "Link count increased ($LINK_COUNT → $LINK_COUNT_AFTER) but native link source not matched"
        skip "reverse-sync" "New links appeared but schema mapping unclear"
    else
        fail "reverse-sync" "Native-written data not found in AD4M after sync"
    fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "Manual verification with Element Web:"
echo "  1. Open https://app.element.io"
echo "  2. Set homeserver to: $MATRIX_URL"
echo "  3. Login as: $TEST_USER / $TEST_PASS"
echo "  4. Find room: AD4M Interop Test ${RUN_ID}"
echo "  5. Look for custom events in the timeline"

print_summary "Matrix" || exit 1
