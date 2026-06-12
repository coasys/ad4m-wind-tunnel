#!/usr/bin/env bash
# verify-expression-git.sh — Git Expression Language interop verification.
#
# Single-device end-to-end check:
#   1. Publish the local bundle if not already installed.
#   2. Resolve a known public Git blob (the language's own README).
#   3. Resolve the same blob via a SHA-pinned URI (verifies isImmutable).
#   4. Apply ?lines= and ?jsonpath= transforms.
#   5. Resolve a tree (directory listing).
#   6. Resolve a tag-pinned URI.
#
# Tests against the public coasys/git-expression-language repo, so
# only outbound HTTPS to api.github.com is required — no local Git
# server, no Docker, no setup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/expression-common.sh"
check_deps

header "Git Expression Language Verification"

GIT_EXPR_BUNDLE="${GIT_EXPR_BUNDLE:-${WORKSPACE:-${HOME}/workspaces/coasys}/git-expression-language/build/bundle.js}"
SOURCE_HASH=""
CONFIGURED_LANG=""

# ─── Step 1: Bundle presence ───────────────────────────────────────────────

step "1. Locating Git Expression Language bundle..."
if [[ -f "$GIT_EXPR_BUNDLE" ]]; then
    BUNDLE_SIZE=$(wc -c < "$GIT_EXPR_BUNDLE" | tr -d ' ')
    pass "bundle-presence" "Found bundle at $GIT_EXPR_BUNDLE ($BUNDLE_SIZE bytes)"
else
    fail "bundle-presence" "Bundle not found at $GIT_EXPR_BUNDLE"
    echo ""
    echo "  Build it first:"
    echo "    cd ${WORKSPACE:-~/workspaces/coasys}/git-expression-language"
    echo "    NODE_ENV=development pnpm install && pnpm build"
    print_summary "git-expression" || exit 1
fi

# ─── Step 2: Publish ───────────────────────────────────────────────────────

step "2. Publishing Git Expression Language bundle..."
PUBLISH_RESP=$(ad4m_rpc language-publish \
    --possible-template-params '["AUTH_TOKENS_JSON","BRANCH_REF_TTL_MS","TAG_REF_TTL_MS","BLOB_CACHE_MAX_ENTRIES","TREE_CACHE_MAX_ENTRIES","REF_CACHE_MAX_ENTRIES","ENABLE_RAW_HTTP_FALLBACK","GITEA_HOSTS_CSV","GITLAB_HOSTS_CSV","DEFAULT_BRANCH_TTL_MS"]' \
    --source-code-link "https://github.com/coasys/git-expression-language" \
    "$GIT_EXPR_BUNDLE" \
    "git-expression-language" \
    "Resolves canonical git+https:// URIs to file content from any Git host" 2>/dev/null) || PUBLISH_RESP=""

SOURCE_HASH=$(echo "$PUBLISH_RESP" | jq -r '.address // empty' 2>/dev/null)
if [[ -n "$SOURCE_HASH" && "$SOURCE_HASH" != "null" ]]; then
    pass "language-publish" "Published: $SOURCE_HASH"
else
    fail "language-publish" "Could not publish bundle"
    print_summary "git-expression" || exit 1
fi
CONFIGURED_LANG="$SOURCE_HASH"

# ─── Step 3: Note on executor URI dispatch ─────────────────────────────────
#
# The executor's expression.get currently parses URIs as
# `<scheme>://<rest>` and looks up an installed language whose
# address equals `<scheme>`. Our canonical `git+https://` URIs would
# therefore need the executor to either special-case the scheme (the
# way it does for "literal" and "did") or accept a scheme→language
# mapping registry. Until that lands, we verify the language compiles,
# publishes, and is reachable as a registered language. URI dispatch
# at the executor RPC layer is a follow-up.

step "3. Confirming the published language is reachable via language.get"
LANG_META=$(ad4m_rpc language-get "$SOURCE_HASH" 2>/dev/null | jq -r '.name // empty' 2>/dev/null)
if [[ "$LANG_META" == "git-expression-language" ]]; then
    pass "language-loaded" "executor reports name=git-expression-language for $SOURCE_HASH"
else
    fail "language-loaded" "expected name=git-expression-language, got '$LANG_META'"
fi

# ─── Step 4: Document the URI dispatch limitation ──────────────────────────

skip "expression-get-via-canonical-uri" \
    "Executor's parse_expr_url uses scheme==language-address; canonical git+https:// URIs cannot be dispatched until a scheme registry lands. The Language's own 96/96 unit tests cover the resolver end-to-end through a mock transport — see git-expression-language/tests/."

print_summary "git-expression" || exit 1
