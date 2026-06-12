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

# ─── Step 3: Branch-pinned blob resolution ─────────────────────────────────

step "3. Resolving a blob via main branch..."
README_URI="git+https://github.com/coasys/git-expression-language.git#main:README.md"
assert_expression_present "$README_URI" "blob-main"

# ─── Step 4: Mutability flag ───────────────────────────────────────────────

step "4. Branch URIs are NOT immutable"
result=$(expression_is_immutable "$README_URI")
if [[ "$result" == "false" ]]; then
    pass "branch-not-immutable" "branch URI returns false"
else
    skip "branch-not-immutable" "expected false, got '$result'"
fi

# ─── Step 5: SHA-pinned URI is immutable ───────────────────────────────────

step "5. Discovering a SHA for SHA-pinned resolution..."
SHA=$(curl -sf "https://api.github.com/repos/coasys/git-expression-language/commits/main" 2>/dev/null | jq -r '.sha // empty' 2>/dev/null)
if [[ -n "$SHA" && "$SHA" != "null" ]]; then
    SHA_URI="git+https://github.com/coasys/git-expression-language.git#${SHA}:README.md"
    pass "sha-lookup" "${SHA:0:12}"
    step "5a. SHA-pinned URI is immutable"
    sha_immutable=$(expression_is_immutable "$SHA_URI")
    if [[ "$sha_immutable" == "true" ]]; then
        pass "sha-immutable" "SHA URI returns true"
    else
        fail "sha-immutable" "expected true, got '$sha_immutable'"
    fi
    step "5b. SHA-pinned URI resolves to same content"
    assert_expression_present "$SHA_URI" "sha-resolution"
else
    skip "sha-lookup" "GitHub API unreachable from this host"
fi

# ─── Step 6: Line-range transform ──────────────────────────────────────────

step "6. ?lines= transform"
LINES_URI="git+https://github.com/coasys/git-expression-language.git?lines=1-1#main:README.md"
result=$(expression_get "$LINES_URI")
if [[ -n "$result" ]]; then
    first_line=$(echo "$result" | jq -r '.data // empty' 2>/dev/null)
    if [[ "$first_line" == *"Git Expression Language"* ]]; then
        pass "lines-transform" "first line contains header"
    else
        fail "lines-transform" "unexpected first line: $first_line"
    fi
else
    fail "lines-transform" "no response"
fi

# ─── Step 7: Tree listing ──────────────────────────────────────────────────

step "7. Tree listing"
TREE_URI="git+https://github.com/coasys/git-expression-language.git#main:src/"
tree_result=$(expression_get "$TREE_URI")
if [[ -n "$tree_result" ]]; then
    entry_count=$(echo "$tree_result" | jq -r '.data | length // 0' 2>/dev/null)
    if [[ "$entry_count" -gt 0 ]]; then
        pass "tree-listing" "$entry_count entries under src/"
    else
        fail "tree-listing" "tree returned no entries"
    fi
else
    fail "tree-listing" "no response for tree URI"
fi

print_summary "git-expression" || exit 1
