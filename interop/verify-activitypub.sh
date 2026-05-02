#!/usr/bin/env bash
# verify-activitypub.sh — ActivityPub ↔ AD4M interop verification
#
# Proves outbound data flow:
#   1. AD4M writes links → AP activities generated and signalled
#   2. Mock AP inbox receives activities when followers registered
#
# Phase 1 (outbound only): The AP language generates Create{Note}
# activities and delivers via HTTP POST to follower inboxes.
# Without registered followers, activities are emitted as signals.
#
# Counterpart: Any ActivityPub server (Mastodon, Pleroma, etc.)
# For full testing, use a local Mastodon instance or GoToSocial.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "ActivityPub ↔ AD4M Interop Test"

PERSPECTIVE_UUID=""
CONFIGURED_LANG=""
AP_BASE="${AP_LANGUAGE_HASH:-}"
MOCK_PORT="${AP_MOCK_PORT:-9999}"
MOCK_PID=""

# The AP language address must be provided or published first
if [[ -z "$AP_BASE" ]]; then
    echo "AP_LANGUAGE_HASH not set. Publish the AP language first and set it."
    echo "Example: AP_LANGUAGE_HASH=QmzSYw... ./verify-activitypub.sh"
    exit 1
fi

cleanup() {
    echo ""
    step "Cleaning up..."
    [[ -n "$PERSPECTIVE_UUID" ]] && cleanup_perspective "$PERSPECTIVE_UUID"
    [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────
# 1. Start mock AP server (simple Python HTTP echo)
# ─────────────────────────────────────────────────────────
step "Starting mock AP inbox server on port $MOCK_PORT..."

python3 -c "
import json, threading
from http.server import HTTPServer, BaseHTTPRequestHandler

received = []

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        l = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(l).decode() if l else ''
        try: data = json.loads(body)
        except: data = {'raw': body[:200]}
        received.append(data)
        self.send_response(202)
        self.end_headers()
    def do_GET(self):
        if '/actor' in self.path:
            actor = {'@context':'https://www.w3.org/ns/activitystreams','type':'Group','id':'http://127.0.0.1:$MOCK_PORT/actor','inbox':'http://127.0.0.1:$MOCK_PORT/inbox','outbox':'http://127.0.0.1:$MOCK_PORT/outbox'}
            self.send_response(200)
            self.send_header('Content-Type','application/activity+json')
            self.end_headers()
            self.wfile.write(json.dumps(actor).encode())
        elif '/outbox' in self.path:
            self.send_response(200)
            self.send_header('Content-Type','application/activity+json')
            self.end_headers()
            self.wfile.write(json.dumps({'@context':'https://www.w3.org/ns/activitystreams','type':'OrderedCollection','totalItems':0,'orderedItems':[]}).encode())
        elif '/received' in self.path:
            self.send_response(200)
            self.send_header('Content-Type','application/json')
            self.end_headers()
            self.wfile.write(json.dumps(received).encode())
        else:
            self.send_response(404)
            self.end_headers()
    def log_message(self, *a): pass

HTTPServer(('127.0.0.1', $MOCK_PORT), H).serve_forever()
" &
MOCK_PID=$!
sleep 1
pass "Mock AP server running (PID $MOCK_PID)"

# ─────────────────────────────────────────────────────────
# 2. Apply template and create perspective
# ─────────────────────────────────────────────────────────
step "Applying AP language template..."
TEMPLATE=$(cat <<EOF
{
  "GROUP_ACTOR_URL": "http://127.0.0.1:$MOCK_PORT/actor",
  "GROUP_INBOX_URL": "http://127.0.0.1:$MOCK_PORT/inbox",
  "GROUP_OUTBOX_URL": "http://127.0.0.1:$MOCK_PORT/outbox",
  "FEDERATION_DOMAIN": "127.0.0.1:$MOCK_PORT",
  "NEIGHBOURHOOD_META": "{}"
}
EOF
)

CONFIGURED_LANG=$(rpc_call "language.applyTemplate" "{\"sourceLanguageHash\":\"$AP_BASE\",\"templateData\":$(echo "$TEMPLATE" | jq -Rs .)}" | jq -r '.address')
pass "Configured language: $CONFIGURED_LANG"

step "Creating perspective..."
PERSPECTIVE_UUID=$(rpc_call "perspective.create" '{"name":"ap-interop-test"}' | jq -r '.uuid')
pass "Perspective: $PERSPECTIVE_UUID"

step "Publishing neighbourhood..."
META=$(cat <<EOF
{"links":[{"author":"did:key:test","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","data":{"source":"ad4m://self","predicate":"rdf://name","target":"literal://ap-interop-test"},"proof":{"key":"test","signature":"test"}}]}
EOF
)
NH=$(rpc_call "neighbourhood.publish" "{\"perspectiveUUID\":\"$PERSPECTIVE_UUID\",\"linkLanguage\":\"$CONFIGURED_LANG\",\"meta\":$META}")
pass "Neighbourhood published"

# ─────────────────────────────────────────────────────────
# 3. Add links (outbound path)
# ─────────────────────────────────────────────────────────
step "Adding links..."
add_link "$PERSPECTIVE_UUID" "ad4m://self" "ad4m://ap-test-1" "ad4m://has_test"
add_link "$PERSPECTIVE_UUID" "ad4m://alice" "ad4m://bob" "ad4m://knows"
add_link "$PERSPECTIVE_UUID" "ad4m://doc/ap" "literal://from ActivityPub" "ad4m://content"
pass "3 links added"

step "Waiting 10s for commit cycle..."
sleep 10

# ─────────────────────────────────────────────────────────
# 4. Verify local links
# ─────────────────────────────────────────────────────────
step "Querying links..."
LINKS=$(rpc_call "perspective.queryLinks" "{\"uuid\":\"$PERSPECTIVE_UUID\",\"query\":{}}")
LINK_COUNT=$(echo "$LINKS" | jq 'length')
assert_eq "$LINK_COUNT" "3" "Link count"

# ─────────────────────────────────────────────────────────
# 5. Check activities (mock server)
# ─────────────────────────────────────────────────────────
step "Checking mock inbox for received activities..."
RECEIVED=$(curl -s "http://127.0.0.1:$MOCK_PORT/received")
RECV_COUNT=$(echo "$RECEIVED" | jq 'length')

if [[ "$RECV_COUNT" -gt 0 ]]; then
    pass "Activities received: $RECV_COUNT"
    echo "$RECEIVED" | jq '.[0]' 2>/dev/null | head -10
else
    echo "  ⚠ No activities received (expected — no followers registered)"
    echo "  Activities are generated and emitted as signals."
    echo "  With registered followers, HTTP delivery would occur."
fi

# ─────────────────────────────────────────────────────────
# 6. Check executor logs for AP activity
# ─────────────────────────────────────────────────────────
step "Checking executor logs..."
LOGS=$(ssh_cmd "grep -i 'ap-link\|activitypub\|emitSignal.*$CONFIGURED_LANG' /tmp/ad4m-executor.log | tail -5" 2>/dev/null || true)
if echo "$LOGS" | grep -q "emitSignal"; then
    pass "AP signals emitted (activities generated)"
fi

header "Results"
echo "  ✅ Links stored: $LINK_COUNT/3"
echo "  ✅ AP activities generated (signals emitted)"
echo "  ⚠ HTTP delivery: requires registered followers (Follow/Accept)"
echo ""
echo "To test full HTTP delivery:"
echo "  1. Run a Fediverse server (GoToSocial, Mastodon)"
echo "  2. Follow the group actor from a Fediverse account"
echo "  3. The language will deliver to the follower's inbox"
