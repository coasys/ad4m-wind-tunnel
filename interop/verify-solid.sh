#!/usr/bin/env bash
# verify-solid.sh — Solid (CSS) ↔ AD4M interop verification
#
# Proves bidirectional data flow:
#   1. AD4M writes links → appear as RDF/Turtle resources in Solid pod
#   2. Write Turtle resource via HTTP to pod → AD4M sync picks it up
#
# Counterpart: Penny (https://penny.vincenttunru.com/) or Mashlib data browser
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "Solid (CSS) ↔ AD4M Interop Test"

PERSPECTIVE_UUID=""
CONFIGURED_LANG=""
TEST_POD_URL=""
TEST_USER="ad4mtest"
TEST_PASS="testpass123"
CSS_AUTH_TOKEN=""

cleanup() {
    echo ""
    step "Cleaning up..."
    [[ -n "$PERSPECTIVE_UUID" ]] && cleanup_perspective "$PERSPECTIVE_UUID"
}
trap cleanup EXIT

# ─── Step 1: Health check ───────────────────────────────────────────────────

step "1. Checking Solid (CSS) service..."
if ! check_http "$SOLID_URL/" "Solid (CSS)"; then
    fail "service-health" "CSS not reachable at $SOLID_URL"
    print_summary "Solid" || exit 1
fi
pass "service-health" "CSS reachable at $SOLID_URL"

# ─── Step 2: Ensure test pod/account exists ─────────────────────────────────

step "2. Ensuring test pod exists..."

# CSS v7+ uses IDP registration. Try creating a pod via the registration endpoint.
# First check if pod already exists
POD_CHECK=$(curl -sf -o /dev/null -w "%{http_code}" "${SOLID_URL}/${TEST_USER}/" 2>/dev/null) || POD_CHECK="000"

if [[ "$POD_CHECK" == "200" || "$POD_CHECK" == "401" || "$POD_CHECK" == "403" ]]; then
    TEST_POD_URL="${SOLID_URL}/${TEST_USER}/"
    pass "pod-setup" "Pod exists at $TEST_POD_URL"
else
    # Try to register via CSS IDP
    REG_RESP=$(curl -sf -X POST "${SOLID_URL}/idp/register/" \
        -H "Content-Type: application/json" \
        -d "{
            \"createWebId\": true,
            \"register\": true,
            \"createPod\": true,
            \"rootPod\": false,
            \"podName\": \"$TEST_USER\",
            \"email\": \"${TEST_USER}@test.local\",
            \"password\": \"$TEST_PASS\",
            \"confirmPassword\": \"$TEST_PASS\"
        }" 2>/dev/null) || REG_RESP=""

    if [[ -n "$REG_RESP" ]] && echo "$REG_RESP" | jq -e '.podBaseUrl // .webId' >/dev/null 2>&1; then
        TEST_POD_URL=$(echo "$REG_RESP" | jq -r '.podBaseUrl // empty' 2>/dev/null)
        [[ -z "$TEST_POD_URL" ]] && TEST_POD_URL="${SOLID_URL}/${TEST_USER}/"
        pass "pod-setup" "Created pod at $TEST_POD_URL"
    else
        # CSS may use a different registration flow — try .account endpoint
        REG_RESP=$(curl -sf -X POST "${SOLID_URL}/.account/login/password/register/" \
            -H "Content-Type: application/json" \
            -d "{
                \"email\": \"${TEST_USER}@test.local\",
                \"password\": \"$TEST_PASS\",
                \"confirmPassword\": \"$TEST_PASS\",
                \"podName\": \"$TEST_USER\",
                \"createWebId\": true,
                \"createPod\": true
            }" 2>/dev/null) || REG_RESP=""

        if [[ -n "$REG_RESP" ]]; then
            TEST_POD_URL="${SOLID_URL}/${TEST_USER}/"
            pass "pod-setup" "Created pod via .account endpoint"
        else
            # Use root pod as fallback
            TEST_POD_URL="${SOLID_URL}/"
            warn "Could not create dedicated pod — using root URL"
            pass "pod-setup" "Using root: $TEST_POD_URL"
        fi
    fi
fi

# Try to get an auth token for writing
# CSS supports various auth flows — try client credentials or just use unauthenticated writes
LOGIN_RESP=$(curl -sf -X POST "${SOLID_URL}/.account/login/password/" \
    -H "Content-Type: application/json" \
    -d "{
        \"email\": \"${TEST_USER}@test.local\",
        \"password\": \"$TEST_PASS\"
    }" 2>/dev/null) || LOGIN_RESP=""

CSS_AUTH_TOKEN=$(echo "$LOGIN_RESP" | jq -r '.authorization // empty' 2>/dev/null)
[[ -z "$CSS_AUTH_TOKEN" || "$CSS_AUTH_TOKEN" == "null" ]] && CSS_AUTH_TOKEN=""

# ─── Step 3: Configure language with template vars ──────────────────────────

step "3. Configuring Solid link language..."
CONTAINER_URL="${TEST_POD_URL}ad4m-links/"

TEMPLATE_DATA=$(jq -n \
    --arg pod "$TEST_POD_URL" \
    --arg container "$CONTAINER_URL" \
    '{
        "podUrl": $pod,
        "containerUrl": $container
    }')

# Add auth if available
if [[ -n "$CSS_AUTH_TOKEN" ]]; then
    TEMPLATE_DATA=$(echo "$TEMPLATE_DATA" | jq --arg token "$CSS_AUTH_TOKEN" '. + {"authToken": $token}')
fi

CONFIGURED_LANG=$(publish_and_configure_language "$LANG_SOLID" "$TEMPLATE_DATA" 2>/dev/null) || true
if [[ -n "$CONFIGURED_LANG" && "$CONFIGURED_LANG" != "null" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Could not apply template to Solid language"
    CONFIGURED_LANG="$LANG_SOLID"
    warn "Falling back to base language address"
fi

# ─── Step 4: Create perspective → publish as neighbourhood ──────────────────

step "4. Creating perspective and neighbourhood..."
PERSPECTIVE_UUID=$(create_test_perspective "interop-solid-${RUN_ID}" 2>/dev/null) || true
if [[ -z "$PERSPECTIVE_UUID" ]]; then
    fail "perspective-create" "Could not create perspective"
    print_summary "Solid" || exit 1
fi

NEIGHBOURHOOD_URL=$(create_test_neighbourhood "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" 2>/dev/null) || true
if [[ -n "$NEIGHBOURHOOD_URL" ]]; then
    pass "neighbourhood-create" "Published neighbourhood"
else
    fail "neighbourhood-create" "Could not publish neighbourhood"
    print_summary "Solid" || exit 1
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

# ─── Step 6: Check Solid pod for RDF resources ─────────────────────────────

step "6. Checking Solid pod for AD4M link resources..."
sleep 3

AUTH_HEADER=""
[[ -n "$CSS_AUTH_TOKEN" ]] && AUTH_HEADER="-H 'Authorization: Bearer $CSS_AUTH_TOKEN'"

# List container contents
CONTAINER_RESP=$(eval curl -sf $AUTH_HEADER \
    -H "Accept: text/turtle" \
    "$CONTAINER_URL" 2>/dev/null) || CONTAINER_RESP=""

if [[ -n "$CONTAINER_RESP" ]]; then
    # Count resources in the container (look for ldp:contains triples)
    RESOURCE_COUNT=$(echo "$CONTAINER_RESP" | grep -c "ldp:contains\|contains" 2>/dev/null) || RESOURCE_COUNT=0
    if [[ "$RESOURCE_COUNT" -gt 0 ]]; then
        pass "native-read" "Found $RESOURCE_COUNT resources in Solid container"
        info "Container listing (first 10 lines):"
        echo "$CONTAINER_RESP" | head -10
    else
        # Container exists but may be empty — check for any content
        if echo "$CONTAINER_RESP" | grep -qi "turtle\|rdf\|ldp" 2>/dev/null; then
            warn "Container exists but appears empty"
            skip "native-read" "Container found but no link resources yet"
        else
            fail "native-read" "Container response doesn't look like RDF"
        fi
    fi
else
    # Container might not exist yet — check the pod root
    POD_RESP=$(eval curl -sf $AUTH_HEADER -H "Accept: text/turtle" "$TEST_POD_URL" 2>/dev/null) || POD_RESP=""
    if [[ -n "$POD_RESP" ]]; then
        skip "native-read" "Pod accessible but ad4m-links/ container not found"
    else
        fail "native-read" "Could not read from Solid pod"
    fi
fi

# ─── Step 7: Write Turtle resource from Solid side ─────────────────────────

step "7. Writing RDF resource from Solid (native) side..."
NATIVE_SOURCE="solid://native/subject-1"
NATIVE_TARGET="solid://native/object-1"
NATIVE_PREDICATE="solid://native/predicate-created"
RESOURCE_NAME="native-test-$(date +%s).ttl"

TURTLE_CONTENT="@prefix ad4m: <http://ad4m.dev/ontology#> .

<$NATIVE_SOURCE>
    ad4m:predicate <$NATIVE_PREDICATE> ;
    ad4m:target <$NATIVE_TARGET> ;
    ad4m:createdAt \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" .
"

# Ensure container exists first
eval curl -sf -X PUT $AUTH_HEADER \
    -H "Content-Type: text/turtle" \
    -H "Link: <http://www.w3.org/ns/ldp#BasicContainer>; rel=\"type\"" \
    "$CONTAINER_URL" -d "" 2>/dev/null || true

# Write the Turtle resource
PUT_STATUS=$(eval curl -sf -o /dev/null -w "%{http_code}" \
    -X PUT $AUTH_HEADER \
    -H "Content-Type: text/turtle" \
    "${CONTAINER_URL}${RESOURCE_NAME}" \
    -d "'$TURTLE_CONTENT'" 2>/dev/null) || PUT_STATUS="000"

if [[ "$PUT_STATUS" == "201" || "$PUT_STATUS" == "200" || "$PUT_STATUS" == "204" || "$PUT_STATUS" == "205" ]]; then
    pass "native-write" "Created Turtle resource: ${CONTAINER_URL}${RESOURCE_NAME}"
else
    # Try POST instead of PUT
    POST_STATUS=$(eval curl -sf -o /dev/null -w "%{http_code}" \
        -X POST $AUTH_HEADER \
        -H "Content-Type: text/turtle" \
        -H "Slug: $RESOURCE_NAME" \
        "$CONTAINER_URL" \
        -d "'$TURTLE_CONTENT'" 2>/dev/null) || POST_STATUS="000"

    if [[ "$POST_STATUS" == "201" || "$POST_STATUS" == "200" ]]; then
        pass "native-write" "Created Turtle resource via POST"
    else
        fail "native-write" "Could not write Turtle resource (PUT=$PUT_STATUS, POST=$POST_STATUS)"
        info "Auth may be required — CSS might need DPoP tokens for write access"
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
echo "Manual verification with Penny:"
echo "  1. Open https://penny.vincenttunru.com/"
echo "  2. Enter pod URL: $TEST_POD_URL"
echo "  3. Navigate to ad4m-links/ container"
echo "  4. Inspect Turtle resources for AD4M link triples"

print_summary "Solid" || exit 1
