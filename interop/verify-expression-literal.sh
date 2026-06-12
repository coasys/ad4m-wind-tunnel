#!/usr/bin/env bash
# verify-expression-literal.sh — Verify the bootstrap "literal" expression language.
#
# The literal language is shipped in every AD4M executor. URIs of the
# form `literal://<type>:<value>` resolve to the inline value:
#
#   literal://string:hello       → "hello"
#   literal://number:42          → 42
#   literal://json:{"a":1}       → { "a": 1 }
#   literal://boolean:true       → true
#
# This script confirms each form round-trips through expression.get.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/expression-common.sh"
check_deps

header "Literal Expression Language Verification"

# ─── Step 1: string ────────────────────────────────────────────────────────

step "1. literal://string:hello"
assert_expression_eq \
    "literal://string:hello" \
    '.data | fromjson' \
    "hello" \
    "string-literal"

# ─── Step 2: number ────────────────────────────────────────────────────────

step "2. literal://number:42"
assert_expression_eq \
    "literal://number:42" \
    '.data | fromjson' \
    "42" \
    "number-literal"

# ─── Step 3: boolean ───────────────────────────────────────────────────────

step "3. literal://boolean:true"
assert_expression_eq \
    "literal://boolean:true" \
    '.data | fromjson' \
    "true" \
    "boolean-literal"

# ─── Step 4: JSON object ───────────────────────────────────────────────────

step "4. literal://json:{\"name\":\"test\",\"value\":1}"
assert_expression_eq \
    'literal://json:{"name":"test","value":1}' \
    '.data | fromjson | .name' \
    "test" \
    "json-object-literal"

# ─── Step 5: immutability ──────────────────────────────────────────────────

step "5. Literal URIs are immutable (content IS the URI)"
result=$(expression_is_immutable "literal://string:hello")
if [[ "$result" == "true" ]]; then
    pass "is-immutable" "literal://string:hello returns true"
else
    fail "is-immutable" "expected true, got '$result'"
fi

print_summary "literal" || exit 1
