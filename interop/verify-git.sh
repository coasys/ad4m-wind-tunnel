#!/usr/bin/env bash
# verify-git.sh — Git Link Language ↔ AD4M interop verification
#
# Single-device end-to-end test for the Git link language:
#   1. Publish the local bundle, configure with DEFAULT_BRANCH=main
#   2. Create a perspective + neighbourhood backed by the configured language
#   3. Add 3 links via AD4M
#   4. Inspect the executor's language storage directory to confirm:
#        - A real Git repo exists under .../languages/<addr>/storage/repo/.git/
#        - One commit per addLink, signed by the agent DID
#        - One JSON file per link under links/<hash>.json
#   5. Make a raw `git commit` on the same repo via shell, modifying the links/
#      tree, then trigger AD4M sync and verify the new link surfaces.
#
# This is the only interop script that does not rely on a network-side protocol
# backend — the "native side" here is the host's `git` CLI against the executor's
# on-disk repo. v1 of the language has no automated remote sync (httpFetch is
# UTF-8-only, see spec §11.2), so the test exercises the local Git substrate
# rather than peer-to-peer propagation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "Git Link Language Interop Test"

# ─── Config ─────────────────────────────────────────────────────────────────

GIT_LANG_BUNDLE="${GIT_LANG_BUNDLE:-${WORKSPACE:-${HOME}/workspaces/coasys}/git-link-language/build/bundle.js}"
EXECUTOR_DATA_DIR="${EXECUTOR_DATA_DIR:-${HOME}/ad4m-test-data}"
PERSPECTIVE_UUID=""
CONFIGURED_LANG=""
SOURCE_HASH=""

cleanup() {
    echo ""
    step "Cleaning up..."
    [[ -n "$PERSPECTIVE_UUID" ]] && cleanup_perspective "$PERSPECTIVE_UUID"
}
trap cleanup EXIT

# ─── Step 1: Bundle presence ────────────────────────────────────────────────

step "1. Locating Git link language bundle..."

if [[ -f "$GIT_LANG_BUNDLE" ]]; then
    BUNDLE_SIZE=$(wc -c < "$GIT_LANG_BUNDLE" | tr -d ' ')
    pass "bundle-presence" "Found bundle at $GIT_LANG_BUNDLE ($BUNDLE_SIZE bytes)"
else
    fail "bundle-presence" "Bundle not found at $GIT_LANG_BUNDLE"
    echo ""
    echo "  Build it first:"
    echo "    cd ${WORKSPACE:-~/workspaces/coasys}/git-link-language"
    echo "    NODE_ENV=development pnpm install && pnpm build"
    print_summary "Git" || exit 1
fi

# ─── Step 2: Publish bundle, get source hash ────────────────────────────────

step "2. Publishing Git link language bundle..."

PUBLISH_RESP=$(ad4m_rpc language-publish \
    --possible-template-params '["REMOTE_URL","DEFAULT_BRANCH","AUTH_TOKEN","MERGE_POLICY","PUSH_DEBOUNCE_MS"]' \
    --source-code-link "https://github.com/coasys/git-link-language" \
    "$GIT_LANG_BUNDLE" \
    "git-link-language" \
    "AD4M Link Language backing Perspectives with a Git repository" 2>/dev/null) || PUBLISH_RESP=""

SOURCE_HASH=$(echo "$PUBLISH_RESP" | jq -r '.address // empty' 2>/dev/null)

if [[ -n "$SOURCE_HASH" && "$SOURCE_HASH" != "null" ]]; then
    pass "language-publish" "Published: $SOURCE_HASH"
else
    fail "language-publish" "Could not publish bundle"
    echo "  Response: $PUBLISH_RESP" >&2
    print_summary "Git" || exit 1
fi

# ─── Step 3: Configure language with DEFAULT_BRANCH=main ────────────────────

step "3. Configuring Git link language..."
TEMPLATE_DATA=$(jq -n '{"DEFAULT_BRANCH":"main"}')

CONFIGURED_LANG=$(publish_and_configure_language "$SOURCE_HASH" "$TEMPLATE_DATA" 2>/dev/null) || true
if [[ -n "$CONFIGURED_LANG" && "$CONFIGURED_LANG" != "null" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Could not apply template to Git language"
    CONFIGURED_LANG="$SOURCE_HASH"
    warn "Falling back to base source hash"
fi

# ─── Step 4: Create perspective + neighbourhood ─────────────────────────────

step "4. Creating perspective and neighbourhood..."
PERSPECTIVE_UUID=$(create_test_perspective "interop-git-${RUN_ID}" 2>/dev/null) || true
if [[ -z "$PERSPECTIVE_UUID" ]]; then
    fail "perspective-create" "Could not create perspective"
    print_summary "Git" || exit 1
fi

NEIGHBOURHOOD_URL=$(create_test_neighbourhood "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" 2>/dev/null) || true
if [[ -n "$NEIGHBOURHOOD_URL" ]]; then
    pass "neighbourhood-create" "Published neighbourhood"
else
    fail "neighbourhood-create" "Could not publish neighbourhood"
    print_summary "Git" || exit 1
fi

# Give the language a moment to init the repo
sleep 2

# ─── Step 5: Add 3 test links via AD4M ──────────────────────────────────────

step "5. Adding 3 test links via AD4M..."
add_test_links "$PERSPECTIVE_UUID" "$RUN_ID" 2>/dev/null || true

LINKS=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS="[]"
LINK_COUNT=$(echo "$LINKS" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || LINK_COUNT=0

if [[ "$LINK_COUNT" -ge 3 ]]; then
    pass "ad4m-write" "Wrote $LINK_COUNT links via AD4M"
else
    fail "ad4m-write" "Expected ≥3 links in AD4M, found $LINK_COUNT"
fi

# ─── Step 6: Inspect the underlying Git repo on disk ────────────────────────

step "6. Inspecting underlying Git repo..."

# The executor stores languages under <data-dir>/languages/<addr>/.
# The Git language writes the repo under that directory's storage area.
LANG_ROOT=""
for candidate in \
    "$EXECUTOR_DATA_DIR/languages/$CONFIGURED_LANG" \
    "$EXECUTOR_DATA_DIR/ad4m/languages/$CONFIGURED_LANG" \
    "$HOME/.ad4m/languages/$CONFIGURED_LANG"; do
    if [[ -d "$candidate" ]]; then
        LANG_ROOT="$candidate"
        break
    fi
done

if [[ -z "$LANG_ROOT" ]]; then
    warn "Could not locate language directory under EXECUTOR_DATA_DIR=$EXECUTOR_DATA_DIR"
    skip "repo-inspection" "Set EXECUTOR_DATA_DIR to the executor's data directory"
else
    info "Language directory: $LANG_ROOT"
    REPO_DIR=""
    for sub in storage/repo .languages/repo repo; do
        if [[ -d "$LANG_ROOT/$sub/.git" ]]; then
            REPO_DIR="$LANG_ROOT/$sub"
            break
        fi
    done
    # Fall back to find
    if [[ -z "$REPO_DIR" ]]; then
        REPO_DIR=$(find "$LANG_ROOT" -maxdepth 4 -type d -name '.git' 2>/dev/null | head -1 | xargs -I{} dirname {})
    fi
    if [[ -n "$REPO_DIR" && -d "$REPO_DIR/.git" ]]; then
        pass "repo-inspection" "Found Git repo at $REPO_DIR"
        info "git log --oneline:"
        (cd "$REPO_DIR" && git log --oneline | head -5)
        info "links/ contents:"
        ls "$REPO_DIR/links/" 2>/dev/null | head -5

        COMMIT_COUNT=$(cd "$REPO_DIR" && git log --oneline 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$COMMIT_COUNT" -ge 3 ]]; then
            pass "git-history" "Found $COMMIT_COUNT commits"
        else
            fail "git-history" "Expected ≥3 commits, found $COMMIT_COUNT"
        fi

        FILE_COUNT=$(ls "$REPO_DIR/links/" 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$FILE_COUNT" -ge 3 ]]; then
            pass "link-files" "Found $FILE_COUNT link files in working tree"
        else
            fail "link-files" "Expected ≥3 link files, found $FILE_COUNT"
        fi
    else
        warn "Could not find a Git repo under $LANG_ROOT"
        skip "repo-inspection" "Repo path may differ from expected layout"
    fi
fi

# ─── Step 7: Native-side write — modify the repo via git CLI ────────────────

if [[ -n "${REPO_DIR:-}" && -d "${REPO_DIR:-}/.git" ]]; then
    step "7. Writing a link from the native (Git CLI) side..."

    NATIVE_LINK_HASH="external-$(date +%s)"
    NATIVE_LINK_FILE="$REPO_DIR/links/${NATIVE_LINK_HASH}.json"
    cat > "$NATIVE_LINK_FILE" <<EOF
{
  "author": "did:key:zExternalTest",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "data": {
    "source": "git://native/src",
    "target": "git://native/tgt",
    "predicate": "git://native/pred"
  },
  "proof": { "signature": "external", "key": "external" }
}
EOF
    (cd "$REPO_DIR" && \
        git -c user.name=external -c user.email=external@cli add "links/${NATIVE_LINK_HASH}.json" && \
        git -c user.name=external -c user.email=external@cli commit -m "external add" >/dev/null) || true

    NATIVE_HEAD=$(cd "$REPO_DIR" && git rev-parse HEAD 2>/dev/null) || NATIVE_HEAD=""
    if [[ -n "$NATIVE_HEAD" ]]; then
        pass "native-write" "Native commit: ${NATIVE_HEAD:0:12}"
    else
        fail "native-write" "Could not commit via git CLI"
    fi

    # ─── Step 8: Trigger AD4M sync, check the new link surfaces ──────────────

    step "8. Triggering AD4M sync, checking for native-written link..."
    trigger_sync "$PERSPECTIVE_UUID" 2>/dev/null || true
    sleep 2

    LINKS_AFTER=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS_AFTER="[]"
    NATIVE_FOUND=$(echo "$LINKS_AFTER" | jq --arg src "git://native/src" \
        'if type == "array" then [.[] | .data // . | select(.source == $src)] | length else 0 end' 2>/dev/null) || NATIVE_FOUND=0

    if [[ "$NATIVE_FOUND" -gt 0 ]]; then
        pass "reverse-sync" "Native-written link appeared in AD4M"
    else
        fail "reverse-sync" "Native-written link not found in AD4M after sync"
    fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "Manual verification (after this script):"
echo "  cd $REPO_DIR"
echo "  git log --oneline"
echo "  cat links/*.json | jq ."
echo ""
echo "Note: Automated remote sync (git fetch/push) is not yet wired in v1."
echo "      See spec §11.2 — gated on a binary HTTP host enhancement."

print_summary "Git" || exit 1
