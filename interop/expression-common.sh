#!/usr/bin/env bash
# expression-common.sh — Helpers for expression-language interop tests.
#
# Sourced by `verify-expression-*.sh` scripts. Provides:
#   expression_get        — call expression.get and return the body
#   expression_create     — call expression.create and return the resulting address
#   assert_expression_eq  — check the resolved Expression.data matches expected
#
# Assumes `common.sh` has already been sourced (for `ad4m_rpc`, `pass`,
# `fail`, etc.).
# shellcheck disable=SC2034

# ---------------------------------------------------------------------------
# Direct expression.get against a fully-qualified URI
# ---------------------------------------------------------------------------

# Usage: expression_get URI
# Returns the raw JSON expression payload on stdout (or empty string on
# failure).
expression_get() {
    local address="$1"
    ad4m_rpc expression-get "$address" 2>/dev/null || echo ""
}

# Usage: expression_create LANGUAGE_ADDRESS CONTENT_JSON
# Returns the new expression address on stdout.
expression_create() {
    local lang="$1" content="$2"
    local result
    result=$(ad4m_rpc expression-create "$lang" "$content" 2>/dev/null) || return 1
    echo "$result" | jq -r '. // empty' 2>/dev/null
}

# Usage: expression_is_immutable URI
# Returns "true" or "false".
expression_is_immutable() {
    local address="$1"
    ad4m_rpc expression-is-immutable "$address" 2>/dev/null | jq -r '. // "false"' 2>/dev/null
}

# Usage: assert_expression_eq URI JQ_FILTER EXPECTED_VALUE TEST_NAME
# Calls expression.get, applies a jq filter against the result, and
# checks the value matches EXPECTED_VALUE.
assert_expression_eq() {
    local address="$1" filter="$2" expected="$3" test_name="$4"
    local result actual
    result=$(expression_get "$address")
    if [[ -z "$result" ]]; then
        fail "$test_name" "expression.get returned no body for $address"
        return 1
    fi
    actual=$(echo "$result" | jq -r "$filter" 2>/dev/null)
    if [[ "$actual" == "$expected" ]]; then
        pass "$test_name" "$address -> $actual"
        return 0
    else
        fail "$test_name" "expected '$expected', got '$actual'"
        return 1
    fi
}

# Usage: assert_expression_present URI TEST_NAME
# Confirms the expression resolves (non-null body, non-null data).
assert_expression_present() {
    local address="$1" test_name="$2"
    local result data
    result=$(expression_get "$address")
    if [[ -z "$result" || "$result" == "null" ]]; then
        fail "$test_name" "no expression body for $address"
        return 1
    fi
    data=$(echo "$result" | jq -c '.data // empty' 2>/dev/null)
    if [[ -z "$data" ]]; then
        fail "$test_name" "expression has no .data for $address"
        return 1
    fi
    pass "$test_name" "$address resolved"
    return 0
}
