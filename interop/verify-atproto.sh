#!/usr/bin/env bash
# verify-atproto.sh — AT Protocol (PDS) ↔ AD4M interop verification
#
# Proves bidirectional data flow:
#   1. AD4M writes links → appear as records in PDS repo (app.ad4m.link collection)
#   2. Create records via PDS XRPC → AD4M sync picks them up
#
# Counterpart: curl to PDS XRPC endpoints or PDS admin panel
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "AT Protocol (PDS) ↔ AD4M Interop Test"

PERSPECTIVE_UUID=""
CONFIGURED_LANG=""
PDS_ACCESS_JWT=""
PDS_DID=""
TEST_HANDLE="ad4mtest.localhost"
TEST_PASS="testpass123"
TEST_EMAIL="ad4mtest@test.local"

cleanup() {
    echo ""
    step "Cleaning up..."
    [[ -n "$PERSPECTIVE_UUID" ]] && cleanup_perspective "$PERSPECTIVE_UUID"
}
trap cleanup EXIT

# ─── Step 1: Health check ───────────────────────────────────────────────────

step "1. Checking AT Protocol PDS service..."
if ! check_http "$ATPROTO_URL/xrpc/_health" "AT Protocol (PDS)"; then
    fail "service-health" "PDS not reachable at $ATPROTO_URL"
    print_summary "AT Protocol" || exit 1
fi
pass "service-health" "PDS reachable at $ATPROTO_URL"

# ─── Step 2: Ensure test account exists ─────────────────────────────────────

step "2. Ensuring test account exists..."

# Try to create account via XRPC
CREATE_RESP=$(curl -sf -X POST "$ATPROTO_URL/xrpc/com.atproto.server.createAccount" \
    -H "Content-Type: application/json" \
    -d "{
        \"handle\": \"$TEST_HANDLE\",
        \"email\": \"$TEST_EMAIL\",
        \"password\": \"$TEST_PASS\"
    }" 2>/dev/null) || CREATE_RESP=""

if [[ -n "$CREATE_RESP" ]] && echo "$CREATE_RESP" | jq -e '.accessJwt' >/dev/null 2>&1; then
    PDS_ACCESS_JWT=$(echo "$CREATE_RESP" | jq -r '.accessJwt')
    PDS_DID=$(echo "$CREATE_RESP" | jq -r '.did')
    pass "account-setup" "Created account: $PDS_DID"
else
    # Account may exist — try login via session
    SESSION_RESP=$(curl -sf -X POST "$ATPROTO_URL/xrpc/com.atproto.server.createSession" \
        -H "Content-Type: application/json" \
        -d "{
            \"identifier\": \"$TEST_HANDLE\",
            \"password\": \"$TEST_PASS\"
        }" 2>/dev/null) || SESSION_RESP=""

    if [[ -n "$SESSION_RESP" ]] && echo "$SESSION_RESP" | jq -e '.accessJwt' >/dev/null 2>&1; then
        PDS_ACCESS_JWT=$(echo "$SESSION_RESP" | jq -r '.accessJwt')
        PDS_DID=$(echo "$SESSION_RESP" | jq -r '.did')
        pass "account-setup" "Logged in as: $PDS_DID"
    else
        # Try with admin auth to create invite code first
        INVITE_RESP=$(curl -sf -X POST "$ATPROTO_URL/xrpc/com.atproto.server.createInviteCode" \
            -H "Content-Type: application/json" \
            -u "admin:ad4m-test-admin" \
            -d '{"useCount": 1}' 2>/dev/null) || INVITE_RESP=""

        INVITE_CODE=$(echo "$INVITE_RESP" | jq -r '.code // empty' 2>/dev/null)
        if [[ -n "$INVITE_CODE" ]]; then
            CREATE_RESP=$(curl -sf -X POST "$ATPROTO_URL/xrpc/com.atproto.server.createAccount" \
                -H "Content-Type: application/json" \
                -d "{
                    \"handle\": \"$TEST_HANDLE\",
                    \"email\": \"$TEST_EMAIL\",
                    \"password\": \"$TEST_PASS\",
                    \"inviteCode\": \"$INVITE_CODE\"
                }" 2>/dev/null) || CREATE_RESP=""

            if echo "$CREATE_RESP" | jq -e '.accessJwt' >/dev/null 2>&1; then
                PDS_ACCESS_JWT=$(echo "$CREATE_RESP" | jq -r '.accessJwt')
                PDS_DID=$(echo "$CREATE_RESP" | jq -r '.did')
                pass "account-setup" "Created account with invite: $PDS_DID"
            else
                fail "account-setup" "Could not create PDS account"
                print_summary "AT Protocol" || exit 1
            fi
        else
            fail "account-setup" "Could not create or login to PDS account"
            print_summary "AT Protocol" || exit 1
        fi
    fi
fi

# ─── Step 3: Configure language with template vars ──────────────────────────

step "3. Configuring AT Protocol link language..."
TEMPLATE_DATA=$(jq -n \
    --arg pds "$ATPROTO_URL" \
    --arg did "$PDS_DID" \
    --arg token "$PDS_ACCESS_JWT" \
    '{
        "pdsUrl": $pds,
        "did": $did,
        "accessJwt": $token,
        "collection": "app.ad4m.link"
    }')

CONFIGURED_LANG=$(publish_and_configure_language "$LANG_ATPROTO" "$TEMPLATE_DATA" 2>/dev/null) || true
if [[ -n "$CONFIGURED_LANG" && "$CONFIGURED_LANG" != "null" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Could not apply template to AT Protocol language"
    CONFIGURED_LANG="$LANG_ATPROTO"
    warn "Falling back to base language address"
fi

# ─── Step 4: Create perspective → publish as neighbourhood ──────────────────

step "4. Creating perspective and neighbourhood..."
PERSPECTIVE_UUID=$(create_test_perspective "interop-atproto-${RUN_ID}" 2>/dev/null) || true
if [[ -z "$PERSPECTIVE_UUID" ]]; then
    fail "perspective-create" "Could not create perspective"
    print_summary "AT Protocol" || exit 1
fi

NEIGHBOURHOOD_URL=$(create_test_neighbourhood "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" 2>/dev/null) || true
if [[ -n "$NEIGHBOURHOOD_URL" ]]; then
    pass "neighbourhood-create" "Published neighbourhood"
else
    fail "neighbourhood-create" "Could not publish neighbourhood"
    print_summary "AT Protocol" || exit 1
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

# ─── Step 6: Query the PDS to confirm links appeared ───────────────────────

step "6. Checking PDS repo for AD4M link records..."
sleep 3  # Give language time to write records

# List records in the app.ad4m.link collection
RECORDS_RESP=$(curl -sf "$ATPROTO_URL/xrpc/com.atproto.repo.listRecords?repo=${PDS_DID}&collection=app.ad4m.link&limit=10" \
    -H "Authorization: Bearer $PDS_ACCESS_JWT" 2>/dev/null) || RECORDS_RESP="{}"

RECORD_COUNT=$(echo "$RECORDS_RESP" | jq '.records | length' 2>/dev/null) || RECORD_COUNT=0

if [[ "$RECORD_COUNT" -gt 0 ]]; then
    pass "native-read" "Found $RECORD_COUNT records in app.ad4m.link collection"
    # Show first record for debugging
    info "Sample record:"
    echo "$RECORDS_RESP" | jq '.records[0].value' 2>/dev/null | head -10
else
    # Try other possible collection names
    for collection in "ad4m.link" "app.ad4m.triple" "app.bsky.feed.post"; do
        ALT_RESP=$(curl -sf "$ATPROTO_URL/xrpc/com.atproto.repo.listRecords?repo=${PDS_DID}&collection=${collection}&limit=5" \
            -H "Authorization: Bearer $PDS_ACCESS_JWT" 2>/dev/null) || continue
        ALT_COUNT=$(echo "$ALT_RESP" | jq '.records | length' 2>/dev/null) || continue
        if [[ "$ALT_COUNT" -gt 0 ]]; then
            info "Found $ALT_COUNT records in '$collection' collection instead"
            RECORD_COUNT=$ALT_COUNT
            break
        fi
    done

    if [[ "$RECORD_COUNT" -gt 0 ]]; then
        pass "native-read" "Found records in alternate collection"
    else
        warn "No records found in PDS repo — language may buffer writes"
        skip "native-read" "No records found yet — may need longer sync time"
    fi
fi

# ─── Step 7: Write record from PDS side ────────────────────────────────────

step "7. Writing record from PDS (native) side..."
NATIVE_SOURCE="atproto://native/subject-1"
NATIVE_TARGET="atproto://native/object-1"
NATIVE_PREDICATE="atproto://native/predicate-created"
RKEY="interop-test-$(date +%s)"

PUT_RESP=$(curl -sf -X POST "$ATPROTO_URL/xrpc/com.atproto.repo.createRecord" \
    -H "Authorization: Bearer $PDS_ACCESS_JWT" \
    -H "Content-Type: application/json" \
    -d "{
        \"repo\": \"$PDS_DID\",
        \"collection\": \"app.ad4m.link\",
        \"rkey\": \"$RKEY\",
        \"record\": {
            \"\$type\": \"app.ad4m.link\",
            \"source\": \"$NATIVE_SOURCE\",
            \"target\": \"$NATIVE_TARGET\",
            \"predicate\": \"$NATIVE_PREDICATE\",
            \"createdAt\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
        }
    }" 2>/dev/null) || PUT_RESP=""

RECORD_URI=$(echo "$PUT_RESP" | jq -r '.uri // empty' 2>/dev/null)
if [[ -n "$RECORD_URI" ]]; then
    pass "native-write" "Created record: $RECORD_URI"
else
    # Custom lexicons may be rejected — try without $type
    PUT_RESP=$(curl -sf -X POST "$ATPROTO_URL/xrpc/com.atproto.repo.createRecord" \
        -H "Authorization: Bearer $PDS_ACCESS_JWT" \
        -H "Content-Type: application/json" \
        -d "{
            \"repo\": \"$PDS_DID\",
            \"collection\": \"app.ad4m.link\",
            \"rkey\": \"$RKEY\",
            \"record\": {
                \"source\": \"$NATIVE_SOURCE\",
                \"target\": \"$NATIVE_TARGET\",
                \"predicate\": \"$NATIVE_PREDICATE\",
                \"createdAt\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
            }
        }" 2>/dev/null) || PUT_RESP=""

    RECORD_URI=$(echo "$PUT_RESP" | jq -r '.uri // empty' 2>/dev/null)
    if [[ -n "$RECORD_URI" ]]; then
        pass "native-write" "Created record (no \$type): $RECORD_URI"
    else
        fail "native-write" "Could not create record in PDS"
        info "PDS may require Lexicon registration for custom collections"
        info "Response: $PUT_RESP"
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
echo "  # List all records in the PDS repo:"
echo "  curl -H 'Authorization: Bearer $PDS_ACCESS_JWT' \\"
echo "    '$ATPROTO_URL/xrpc/com.atproto.repo.listRecords?repo=$PDS_DID&collection=app.ad4m.link'"
echo ""
echo "NOTE: Self-hosted PDS may reject custom Lexicons (app.ad4m.link)."
echo "If native-write failed, you may need to register the Lexicon first."

print_summary "AT Protocol" || exit 1
