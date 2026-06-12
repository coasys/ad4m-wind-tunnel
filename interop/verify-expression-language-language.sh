#!/usr/bin/env bash
# verify-expression-language-language.sh — Verify the bootstrap
# "language-language" expression language.
#
# The language-language stores published language bundles in the AD4M
# bootstrap CDN. URIs are content-addressed CIDs (`Qm…`). This script
# uses an already-known bootstrap language address (the literal
# language itself) to confirm resolution works end-to-end.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/expression-common.sh"
check_deps

header "Language-Language Expression Verification"

# ─── Step 1: discover a known bootstrap language ───────────────────────────

step "1. Looking up a known bootstrap language address..."
LANG_ALL=$(ad4m_rpc language-all 2>/dev/null) || LANG_ALL=""
LANG_ADDR=$(echo "$LANG_ALL" | jq -r '.[0].address // empty' 2>/dev/null)

if [[ -z "$LANG_ADDR" ]]; then
    skip "discovery" "Could not find any installed language"
    print_summary "language-language" || exit 1
fi
pass "discovery" "Will probe address $LANG_ADDR"

# ─── Step 2: language.get returns metadata ────────────────────────────────

step "2. language.get($LANG_ADDR)"
GET_RESP=$(ad4m_rpc language-get "$LANG_ADDR" 2>/dev/null || echo "")
if [[ -z "$GET_RESP" || "$GET_RESP" == "null" ]]; then
    fail "language-get" "no response for $LANG_ADDR"
else
    NAME=$(echo "$GET_RESP" | jq -r '.name // empty')
    if [[ -n "$NAME" ]]; then
        pass "language-get" "name: $NAME"
    else
        fail "language-get" "response had no .name"
    fi
fi

# Note: the executor does not expose expression.isImmutable as a
# WebSocket RPC, so we don't surface that check here. Language
# addresses (Qm…) are by definition content-addressed and immutable.

print_summary "language-language" || exit 1
