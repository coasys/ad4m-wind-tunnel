#!/usr/bin/env bash
# common-matrix.sh — Shared helpers for Matrix ↔ AD4M/Flux bridge scripts
#
# Provides Matrix API helpers, AD4M WS RPC helpers, Flux seed generation,
# and neighbourhood binding utilities. Self-contained — no external deps
# beyond standard tools (curl, jq, python3, sqlite3, docker).
#
# shellcheck disable=SC2034

set -euo pipefail

MATRIX_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MATRIX_REPO_DIR="$(cd "$MATRIX_COMMON_DIR/../.." && pwd)"

# ─── Colors & output (wind-tunnel conventions) ──────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✅${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}❌${NC} $*"; }
header()  { echo -e "\n${BOLD}${CYAN}═══ $* ═══${NC}"; }
step()    { echo -e "${BOLD}→${NC} $*"; }

# ─── Results tracking ───────────────────────────────────────────────────────

RESULTS=()

pass() {
    local name="$1" detail="${2:-}"
    RESULTS+=("PASS:$name:$detail")
    echo -e "  ${GREEN}✅ PASS:${NC} ${name}${detail:+ — $detail}"
}

fail() {
    local name="$1" detail="${2:-}"
    RESULTS+=("FAIL:$name:$detail")
    echo -e "  ${RED}❌ FAIL:${NC} ${name}${detail:+ — $detail}"
}

skip() {
    local name="$1" reason="${2:-}"
    RESULTS+=("SKIP:$name:$reason")
    echo -e "  ${YELLOW}⏭️  SKIP:${NC} ${name}${reason:+ — $reason}"
}

print_summary() {
    local title="$1"
    local passed=0 failed=0 skipped=0
    for r in "${RESULTS[@]}"; do
        case "$r" in PASS:*) ((passed++)) ;; FAIL:*) ((failed++)) ;; SKIP:*) ((skipped++)) ;; esac
    done
    echo -e "\n${BOLD}═══ $title Summary ═══${NC}"
    echo -e "  ${GREEN}Passed:${NC}  $passed"
    echo -e "  ${RED}Failed:${NC}  $failed"
    echo -e "  ${YELLOW}Skipped:${NC} $skipped"
    echo ""
    if [[ $failed -gt 0 ]]; then
        echo -e "  ${RED}${BOLD}OVERALL: FAIL${NC}"
        return 1
    else
        echo -e "  ${GREEN}${BOLD}OVERALL: PASS${NC}"
        return 0
    fi
}

# ─── Dependency check ───────────────────────────────────────────────────────

check_matrix_deps() {
    local missing=()
    command -v docker >/dev/null 2>&1  || missing+=(docker)
    command -v python3 >/dev/null 2>&1 || missing+=(python3)
    command -v jq >/dev/null 2>&1      || missing+=(jq)
    command -v curl >/dev/null 2>&1    || missing+=(curl)
    command -v sqlite3 >/dev/null 2>&1 || missing+=(sqlite3)
    if ! python3 -c "import websockets" 2>/dev/null; then
        missing+=("python3-websockets (pip3 install websockets)")
    fi
    if [[ ${#missing[@]} -gt 0 ]]; then
        error "Missing tools: ${missing[*]}"
        exit 1
    fi
}

# ─── Matrix API helpers ─────────────────────────────────────────────────────

# Register a user; fall back to login if already registered. Returns access_token.
# Usage: matrix_register_or_login MATRIX_URL USERNAME PASSWORD
matrix_register_or_login() {
    local url="$1" username="$2" password="$3"
    local token=""

    # Try register
    local reg_resp
    reg_resp=$(curl -sf -X POST "${url}/_matrix/client/v3/register" \
        -H "Content-Type: application/json" \
        -d "$(jq -nc --arg u "$username" --arg p "$password" \
            '{username:$u, password:$p, auth:{type:"m.login.dummy"}, inhibit_login:false}')" 2>/dev/null) || reg_resp=""
    token=$(echo "$reg_resp" | jq -r '.access_token // empty' 2>/dev/null)

    # Fallback: login
    if [[ -z "$token" ]]; then
        local login_resp
        login_resp=$(curl -sf -X POST "${url}/_matrix/client/v3/login" \
            -H "Content-Type: application/json" \
            -d "$(jq -nc --arg u "$username" --arg p "$password" \
                '{type:"m.login.password", identifier:{type:"m.id.user",user:$u}, password:$p}')" 2>/dev/null) || login_resp=""
        token=$(echo "$login_resp" | jq -r '.access_token // empty' 2>/dev/null)
    fi

    echo "$token"
}

# Create a room. Returns room_id.
# Usage: matrix_create_room MATRIX_URL ACCESS_TOKEN ROOM_NAME [ALIAS]
matrix_create_room() {
    local url="$1" token="$2" name="$3" alias="${4:-}"
    local body
    if [[ -n "$alias" ]]; then
        body=$(jq -nc --arg n "$name" --arg a "$alias" '{name:$n, preset:"public_chat", room_alias_name:$a}')
    else
        body=$(jq -nc --arg n "$name" '{name:$n, preset:"public_chat"}')
    fi

    local resp
    resp=$(curl -sf -X POST "${url}/_matrix/client/v3/createRoom" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$body" 2>/dev/null) || resp=""
    local room_id
    room_id=$(echo "$resp" | jq -r '.room_id // empty' 2>/dev/null)

    # If room exists (alias taken), resolve via directory
    if [[ -z "$room_id" && -n "$alias" ]]; then
        local encoded_alias
        encoded_alias=$(python3 -c "import urllib.parse; print(urllib.parse.quote('#${alias}:ad4m-test.local'))" 2>/dev/null || echo "%23${alias}%3Aad4m-test.local")
        local alias_resp
        alias_resp=$(curl -sf "${url}/_matrix/client/v3/directory/room/${encoded_alias}" 2>/dev/null) || alias_resp=""
        room_id=$(echo "$alias_resp" | jq -r '.room_id // empty' 2>/dev/null)
    fi

    echo "$room_id"
}

# Join a room.
# Usage: matrix_join_room MATRIX_URL ACCESS_TOKEN ROOM_ID
matrix_join_room() {
    local url="$1" token="$2" room_id="$3"
    curl -sf -X POST "${url}/_matrix/client/v3/join/${room_id}" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d '{}' >/dev/null 2>&1 || true
}

# Send a text message. Returns event_id.
# Usage: matrix_send_message MATRIX_URL ACCESS_TOKEN ROOM_ID BODY [TXNID]
matrix_send_message() {
    local url="$1" token="$2" room_id="$3" body="$4" txnid="${5:-txn-$(date +%s)-$$}"
    local resp
    resp=$(curl -sf -X PUT \
        "${url}/_matrix/client/v3/rooms/${room_id}/send/m.room.message/${txnid}" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg b "$body" '{msgtype:"m.text", body:$b}')" 2>/dev/null) || resp=""
    echo "$resp" | jq -r '.event_id // empty' 2>/dev/null
}

# Get room messages. Returns JSON chunk.
# Usage: matrix_get_messages MATRIX_URL ACCESS_TOKEN ROOM_ID [LIMIT] [DIR]
matrix_get_messages() {
    local url="$1" token="$2" room_id="$3" limit="${4:-50}" dir="${5:-b}"
    curl -sf "${url}/_matrix/client/v3/rooms/${room_id}/messages?dir=${dir}&limit=${limit}" \
        -H "Authorization: Bearer $token" 2>/dev/null || echo "{}"
}

# List rooms the user has joined. Returns JSON array of {room_id, name}.
# Usage: matrix_list_rooms MATRIX_URL ACCESS_TOKEN
matrix_list_rooms() {
    local url="$1" token="$2"
    local resp
    resp=$(curl -sf "${url}/_matrix/client/v3/joined_rooms" \
        -H "Authorization: Bearer $token" 2>/dev/null) || resp="{}"
    local room_ids
    room_ids=$(echo "$resp" | jq -r '.joined_rooms[]? // empty' 2>/dev/null)
    local result="[]"
    for rid in $room_ids; do
        local state
        state=$(curl -sf "${url}/_matrix/client/v3/rooms/${rid}/state/m.room.name" \
            -H "Authorization: Bearer $token" 2>/dev/null) || state="{}"
        local rname
        rname=$(echo "$state" | jq -r '.name // "(unnamed)"' 2>/dev/null)
        result=$(echo "$result" | jq --arg id "$rid" --arg n "$rname" '. + [{room_id: $id, name: $n}]')
    done
    echo "$result"
}

# ─── AD4M WS RPC helper ─────────────────────────────────────────────────────

# AD4M RPC script path
AD4M_RPC_SCRIPT="${AD4M_RPC_SCRIPT:-$MATRIX_REPO_DIR/scripts/ad4m-rpc.py}"

# Execute a WS RPC command against the AD4M executor.
# Requires AD4M_HOST, RPC_PORT, CREDENTIAL to be set.
# Usage: ad4m_rpc COMMAND [ARGS...]
ad4m_rpc() {
    python3 "$AD4M_RPC_SCRIPT" \
        --host "${AD4M_HOST:-127.0.0.1}" \
        --port "${RPC_PORT:-12100}" \
        --token "${CREDENTIAL:-test123}" \
        "$@"
}

# ─── URL readiness ───────────────────────────────────────────────────────────

# Poll a URL until it responds with HTTP 2xx.
# Usage: wait_for_url URL LABEL [MAX_SECONDS]
wait_for_url() {
    local url="$1" label="$2" max_wait="${3:-30}"
    for i in $(seq 1 "$max_wait"); do
        if curl -sf "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# ─── Flux seed generation (inline, no external dependencies) ────────────────

# Generate a Flux-compatible community seed JSON.
# Includes full SHACL schema for Community, Channel, Message, and App.
# Usage: generate_flux_seed COMMUNITY_NAME OUTPUT_FILE [NUM_CHANNELS]
generate_flux_seed() {
    local community_name="$1" output_file="$2" num_channels="${3:-1}"
    python3 << 'PYEOF' - "$community_name" "$output_file" "$num_channels"
import json, sys, uuid as _uuid
from datetime import datetime, timezone

community_name = sys.argv[1]
output_file = sys.argv[2]
num_channels = int(sys.argv[3])

MOCK_DID = "did:key:z6MkdevtoolsMockSeedGenerator0000000000000000"

# Predicate constants
SELF = "ad4m://self"
HAS_SUBJECT_CLASS = "ad4m://has_subject_class"
HAS_SHACL = "ad4m://has_shacl"
SHACL_SHAPE_URI = "ad4m://shacl_shape_uri"
SDNA = "ad4m://sdna"
SHAPE = "ad4m://shape"
CONSTRUCTOR = "ad4m://constructor"
DESTRUCTOR = "ad4m://destructor"
SETTER = "ad4m://setter"
WRITABLE = "ad4m://writable"
RESOLVE_LANG = "ad4m://resolveLanguage"
RDF_TYPE = "rdf://type"
RDF_NAME = "rdf://name"
RDF_DESC = "rdf://description"
SH_NODE_SHAPE = "sh://NodeShape"
SH_PROPERTY_SHAPE = "sh://PropertyShape"
SH_PROPERTY = "sh://property"
SH_PATH = "sh://path"
SH_DATATYPE = "sh://datatype"
SH_MIN_COUNT = "sh://minCount"
SH_MAX_COUNT = "sh://maxCount"
XSD_STRING = "xsd://string"
XSD_BOOLEAN = "xsd://boolean"
ENTRY_TYPE = "flux://entry_type"
CHANNEL = "flux://has_channel"
CHANNEL_NAME = "flux://has_channel_name"
CHANNEL_DESC = "flux://has_channel_description"
CHANNEL_IS_CONV = "flux://channel_is_conversation"
CHANNEL_IS_PINNED = "flux://channel_is_pinned"
BODY = "flux://body"
AD4M_HAS_CHILD = "ad4m://has_child"
RDF_ICON = "rdf://icon"
RDF_PKG = "rdf://pkg"
ET_COMMUNITY = "flux://has_community"
ET_CHANNEL = "flux://has_channel"
ET_MESSAGE = "flux://has_message"
ET_APP = "flux://has_app"

now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

def link(source, predicate, target):
    return {
        "author": MOCK_DID,
        "timestamp": now,
        "data": {"source": source, "predicate": predicate, "target": target},
        "proof": {"signature": "", "key": ""},
        "status": "shared",
    }

def property_shape(shape_uri, prop_name, path, datatype=XSD_STRING,
                    writable=True, min_count=None, max_count=None,
                    setter=None, resolve_language=None):
    links = []
    prop_uri = f"{shape_uri}.{prop_name}"
    links.append(link(shape_uri, SH_PROPERTY, prop_uri))
    links.append(link(prop_uri, RDF_TYPE, SH_PROPERTY_SHAPE))
    links.append(link(prop_uri, SH_PATH, path))
    links.append(link(prop_uri, SH_DATATYPE, datatype))
    if min_count is not None:
        links.append(link(prop_uri, SH_MIN_COUNT, f"literal:{min_count}^^xsd:integer"))
    if max_count is not None:
        links.append(link(prop_uri, SH_MAX_COUNT, f"literal:{max_count}^^xsd:integer"))
    links.append(link(prop_uri, WRITABLE, f"literal:boolean:{'true' if writable else 'false'}"))
    if setter:
        links.append(link(prop_uri, SETTER, f"literal:string:{json.dumps(setter)}"))
    if resolve_language:
        links.append(link(prop_uri, RESOLVE_LANG, f"literal:string:{resolve_language}"))
    return links

def model_schema(name, properties, constructor_actions, destructor_actions):
    links = []
    shape_uri = f"flux://{name}Shape"
    class_uri = f"flux://{name}"
    links.append(link(SELF, HAS_SUBJECT_CLASS, f"literal:string:{name}"))
    links.append(link(SELF, HAS_SHACL, f"literal:string:shacl://{name}"))
    links.append(link(f"literal:string:shacl://{name}", SHACL_SHAPE_URI, shape_uri))
    links.append(link(f"literal:string:{name}", SDNA, "literal:string:"))
    links.append(link(class_uri, RDF_TYPE, "ad4m://SubjectClass"))
    links.append(link(class_uri, SHAPE, shape_uri))
    links.append(link(shape_uri, RDF_TYPE, SH_NODE_SHAPE))
    if constructor_actions:
        links.append(link(shape_uri, CONSTRUCTOR, f"literal:string:{json.dumps(constructor_actions)}"))
    if destructor_actions:
        links.append(link(shape_uri, DESTRUCTOR, f"literal:string:{json.dumps(destructor_actions)}"))
    for prop in properties:
        links.extend(property_shape(
            shape_uri, prop["name"], prop["path"],
            datatype=prop.get("datatype", XSD_STRING),
            writable=prop.get("writable", True),
            min_count=prop.get("min_count"),
            max_count=prop.get("max_count"),
            setter=prop.get("setter"),
            resolve_language=prop.get("resolve_language"),
        ))
    return links

# Build schema
all_links = []

# Community
all_links.extend(model_schema("Community", [
    {"name": "type", "path": ENTRY_TYPE, "writable": False, "min_count": 1, "max_count": 1},
    {"name": "name", "path": RDF_NAME, "writable": True, "max_count": 1,
     "resolve_language": "literal",
     "setter": [{"action":"setSingleTarget","source":"this","predicate":RDF_NAME,"target":"value"}]},
    {"name": "description", "path": RDF_DESC, "writable": True, "max_count": 1, "resolve_language": "literal"},
], [{"action":"addLink","source":"this","predicate":ENTRY_TYPE,"target":ET_COMMUNITY}],
   [{"action":"removeLink","source":"this","predicate":ENTRY_TYPE,"target":"*"}]))

# Channel
all_links.extend(model_schema("Channel", [
    {"name": "type", "path": ENTRY_TYPE, "writable": False, "min_count": 1, "max_count": 1},
    {"name": "name", "path": CHANNEL_NAME, "writable": True, "max_count": 1,
     "resolve_language": "literal",
     "setter": [{"action":"setSingleTarget","source":"this","predicate":CHANNEL_NAME,"target":"value"}]},
    {"name": "description", "path": CHANNEL_DESC, "writable": True, "max_count": 1, "resolve_language": "literal"},
    {"name": "isConversation", "path": CHANNEL_IS_CONV, "datatype": XSD_BOOLEAN, "writable": True, "max_count": 1},
    {"name": "isPinned", "path": CHANNEL_IS_PINNED, "datatype": XSD_BOOLEAN, "writable": True, "max_count": 1},
], [{"action":"addLink","source":"this","predicate":ENTRY_TYPE,"target":ET_CHANNEL}],
   [{"action":"removeLink","source":"this","predicate":ENTRY_TYPE,"target":"*"}]))

# Message
all_links.extend(model_schema("Message", [
    {"name": "type", "path": ENTRY_TYPE, "writable": False, "min_count": 1, "max_count": 1},
    {"name": "body", "path": BODY, "writable": True, "max_count": 1,
     "resolve_language": "literal",
     "setter": [{"action":"setSingleTarget","source":"this","predicate":BODY,"target":"value"}]},
], [{"action":"addLink","source":"this","predicate":ENTRY_TYPE,"target":ET_MESSAGE}],
   [{"action":"removeLink","source":"this","predicate":ENTRY_TYPE,"target":"*"}]))

# App
all_links.extend(model_schema("App", [
    {"name": "type", "path": ENTRY_TYPE, "writable": False, "min_count": 1, "max_count": 1},
    {"name": "name", "path": RDF_NAME, "writable": True, "max_count": 1, "resolve_language": "literal"},
    {"name": "description", "path": RDF_DESC, "writable": True, "max_count": 1, "resolve_language": "literal"},
    {"name": "icon", "path": RDF_ICON, "writable": True, "max_count": 1, "resolve_language": "literal"},
    {"name": "pkg", "path": RDF_PKG, "writable": True, "max_count": 1, "resolve_language": "literal"},
], [{"action":"addLink","source":"this","predicate":ENTRY_TYPE,"target":ET_APP}],
   [{"action":"removeLink","source":"this","predicate":ENTRY_TYPE,"target":"*"}]))

# Community instance data
import random, string
def _id():
    return "".join(random.choices(string.ascii_lowercase, k=5))

community_id = f"literal:string:{_id()}"
all_links.append(link(community_id, ENTRY_TYPE, ET_COMMUNITY))
all_links.append(link(community_id, RDF_NAME, f"literal:string:{community_name}"))
all_links.append(link(community_id, RDF_DESC, "literal:string:Bridged Matrix community"))

channel_names = ["general", "random", "dev", "design", "feedback", "announcements"]
for ch_idx in range(num_channels):
    channel_id = f"literal:string:{_id()}"
    ch_name = channel_names[ch_idx % len(channel_names)]
    all_links.append(link(channel_id, ENTRY_TYPE, ET_CHANNEL))
    all_links.append(link(channel_id, CHANNEL_NAME, f"literal:string:{ch_name}"))
    all_links.append(link(channel_id, CHANNEL_DESC, f"literal:string:The {ch_name} channel"))
    all_links.append(link(channel_id, CHANNEL_IS_CONV, "literal:boolean:false"))
    all_links.append(link(channel_id, CHANNEL_IS_PINNED, "literal:boolean:false"))
    all_links.append(link(community_id, CHANNEL, channel_id))
    # Chat view App
    app_id = f"literal:string:{_id()}"
    all_links.append(link(app_id, ENTRY_TYPE, ET_APP))
    all_links.append(link(app_id, RDF_NAME, "literal:string:Chat"))
    all_links.append(link(app_id, RDF_DESC, "literal:string:Real time messaging"))
    all_links.append(link(app_id, RDF_ICON, "literal:string:chat"))
    all_links.append(link(app_id, RDF_PKG, "literal:string:@coasys/flux-chat-view"))
    all_links.append(link(channel_id, AD4M_HAS_CHILD, app_id))

seed = {
    "uuid": str(_uuid.uuid4()),
    "name": community_name,
    "sharedUrl": None,
    "state": None,
    "neighbourhood": None,
    "links": all_links,
}

with open(output_file, "w") as f:
    json.dump(seed, f, indent=2)
    f.write("\n")
print(f"Generated seed: {community_name} ({len(all_links)} links)", file=sys.stderr)
PYEOF
}

# ─── Neighbourhood binding (SQLite hack) ────────────────────────────────────

# Bind a configured link language to a perspective via direct SQLite update.
# Usage: bind_neighbourhood DB_PATH PERSPECTIVE_UUID CONFIGURED_LANG AGENT_DID
bind_neighbourhood() {
    local db_path="$1" perspective_uuid="$2" configured_lang="$3" agent_did="$4"
    local iso_now
    iso_now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

    python3 << PYEOF
import sqlite3, json, sys

db_path = "$db_path"
perspective_uuid = "$perspective_uuid"
configured_lang = "$configured_lang"
agent_did = "$agent_did"
iso_now = "$iso_now"

try:
    db = sqlite3.connect(db_path)
    nh = {
        "author": agent_did,
        "data": {
            "linkLanguage": configured_lang,
            "meta": {"links": []}
        },
        "proof": {
            "key": "#key1",
            "signature": "local_test_proof",
            "valid": True,
            "invalid": False
        },
        "timestamp": iso_now
    }
    db.execute(
        'UPDATE perspective_handle SET neighbourhood = ?, shared_url = ?, state = ?, owners = ? WHERE uuid = ?',
        (json.dumps(nh), 'neighbourhood://local-matrix-bridge', '"Synced"', json.dumps([agent_did]), perspective_uuid)
    )
    db.commit()
    row = db.execute('SELECT neighbourhood FROM perspective_handle WHERE uuid = ?', (perspective_uuid,)).fetchone()
    if row and row[0]:
        data = json.loads(row[0])
        lang = data.get("data", {}).get("linkLanguage", "")
        print(f"OK: bound language {lang[:30]}...")
    else:
        print("FAILED: no neighbourhood data after update")
        sys.exit(1)
    db.close()
except Exception as e:
    print(f"ERROR: {e}")
    sys.exit(1)
PYEOF
}

# ─── Executor management ────────────────────────────────────────────────────

# Start the AD4M executor in language-language-only mode.
# Usage: start_executor AD4M_EXECUTOR DATA_DIR SEED_PATH PORT CREDENTIAL
# Sets EXECUTOR_PID in the caller's scope.
start_executor() {
    local executor="$1" data_dir="$2" seed_path="$3" port="$4" credential="$5"

    # Init
    step "Initialising AD4M executor..."
    mkdir -p "$data_dir/ad4m-data"
    "$executor" init \
        --data-path "$data_dir/ad4m-data" \
        --network-bootstrap-seed "$seed_path" > /dev/null 2>&1

    step "Starting AD4M executor (language-language-only, port $port)..."
    "$executor" run \
        --app-data-path "$data_dir/ad4m-data" \
        --language-language-only true \
        --hc-use-bootstrap false \
        --connect-holochain false \
        --run-dapp-server false \
        --port "$port" \
        --admin-credential "$credential" \
        --enable-multi-user true \
        > "$data_dir/executor.log" 2>&1 &
    EXECUTOR_PID=$!

    # Wait for health endpoint
    local health_url="http://127.0.0.1:${port}/api/v1/health"
    local ready=false
    for i in $(seq 1 30); do
        if curl -sf "$health_url" >/dev/null 2>&1; then
            ready=true
            break
        fi
        if ! kill -0 "$EXECUTOR_PID" 2>/dev/null; then
            error "Executor died. Last log lines:"
            tail -15 "$data_dir/executor.log" 2>/dev/null | sed 's/^/    /'
            return 1
        fi
        sleep 1
    done

    if [[ "$ready" == "true" ]]; then
        info "Executor ready (PID $EXECUTOR_PID, port $port)"
        return 0
    else
        error "Executor not ready after 30s"
        return 1
    fi
}

# ─── Language publish & configure ────────────────────────────────────────────

# Publish a language bundle and return the language hash.
# Usage: publish_language BUNDLE_PATH
publish_language() {
    local bundle_path="$1"

    local result
    result=$(ad4m_rpc language-publish "$bundle_path" "matrix-link-language" \
        "Matrix bridge link language for Flux interop" \
        --possible-template-params '["MATRIX_HOMESERVER_URL","MATRIX_ROOM_ID","MATRIX_USER_ID","MATRIX_ACCESS_TOKEN","MATRIX_ROOM_ALIAS","NEIGHBOURHOOD_META"]' \
        2>/dev/null) || result=""
    local hash
    hash=$(echo "$result" | jq -r '.address // empty' 2>/dev/null)

    # Fallback without possibleTemplateParams
    if [[ -z "$hash" ]]; then
        result=$(ad4m_rpc language-publish "$bundle_path" "matrix-link-language" \
            "Matrix bridge link language" 2>/dev/null) || result=""
        hash=$(echo "$result" | jq -r '.address // empty' 2>/dev/null)
    fi

    if [[ -n "$hash" ]]; then
        echo "$hash"
    else
        error "Failed to publish language: $result" >&2
        return 1
    fi
}

# Apply a language template with Matrix credentials.
# Usage: apply_language_template LANG_HASH MATRIX_URL ROOM_ID BRIDGE_USER_ID BRIDGE_TOKEN [ROOM_ALIAS] [META]
apply_language_template() {
    local lang_hash="$1" matrix_url="$2" room_id="$3" user_id="$4" token="$5"
    local room_alias="${6:-}" meta="${7:-{}}"

    local template_data
    template_data=$(jq -nc \
        --arg hs "$matrix_url" \
        --arg room "$room_id" \
        --arg user "$user_id" \
        --arg token "$token" \
        --arg alias "$room_alias" \
        --arg meta "$meta" \
        '{MATRIX_HOMESERVER_URL:$hs, MATRIX_ROOM_ID:$room, MATRIX_USER_ID:$user, MATRIX_ACCESS_TOKEN:$token, MATRIX_ROOM_ALIAS:$alias, NEIGHBOURHOOD_META:$meta}')

    local result
    result=$(ad4m_rpc language-apply-template "$lang_hash" "$template_data" 2>/dev/null) || result=""
    local configured
    configured=$(echo "$result" | jq -r '.address // empty' 2>/dev/null)

    if [[ -n "$configured" ]]; then
        echo "$configured"
    else
        error "Failed to apply template: $result" >&2
        return 1
    fi
}

# ─── Bootstrap seed creation ────────────────────────────────────────────────

# Create a minimal bootstrap seed from mainnet_seed.json
# Usage: create_bootstrap_seed MAINNET_SEED_PATH OUTPUT_PATH
create_bootstrap_seed() {
    local mainnet_seed="$1" output_path="$2"
    python3 -c "
import json
with open('$mainnet_seed') as f:
    mainnet = json.load(f)
seed = {
    'trustedAgents': [],
    'knownLinkLanguages': [],
    'directMessageLanguage': '',
    'agentLanguage': '',
    'perspectiveLanguage': '',
    'neighbourhoodLanguage': '',
    'languageLanguageBundle': mainnet.get('languageLanguageBundle', ''),
}
with open('$output_path', 'w') as f:
    json.dump(seed, f, indent=2)
print('OK')
"
}

# ─── Agent init/unlock ───────────────────────────────────────────────────────

# Initialise or unlock the AD4M agent. Returns the agent DID.
# Usage: init_or_unlock_agent PASSPHRASE
init_or_unlock_agent() {
    local passphrase="$1"
    local status_result
    status_result=$(ad4m_rpc agent-status 2>/dev/null) || status_result=""
    local is_init is_unlocked agent_did

    is_init=$(echo "$status_result" | jq -r '.isInitialized // false' 2>/dev/null)
    is_unlocked=$(echo "$status_result" | jq -r '.isUnlocked // false' 2>/dev/null)
    agent_did=$(echo "$status_result" | jq -r '.did // empty' 2>/dev/null)

    if [[ "$is_init" != "true" ]]; then
        step "Generating new agent..." >&2
        local gen_result
        gen_result=$(ad4m_rpc agent-generate 2>/dev/null) || gen_result=""
        agent_did=$(echo "$gen_result" | jq -r '.did // empty' 2>/dev/null)
        if [[ -z "$agent_did" ]]; then
            error "Failed to generate agent: $gen_result" >&2
            return 1
        fi
    elif [[ "$is_unlocked" != "true" ]]; then
        step "Unlocking existing agent..." >&2
        local unlock_result
        unlock_result=$(ad4m_rpc raw "agent.unlock" "{\"passphrase\":\"$passphrase\",\"holochain\":false}" 2>/dev/null) || unlock_result=""
        agent_did=$(echo "$unlock_result" | jq -r '.did // empty' 2>/dev/null)
        if [[ -z "$agent_did" ]]; then
            error "Failed to unlock agent: $unlock_result" >&2
            return 1
        fi
    fi

    echo "$agent_did"
}
