#!/usr/bin/env bash
# run-tests.sh — Main test runner for AD4M Link Language integration tests
# Usage: ./scripts/run-tests.sh [--language <name>] [--list]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
load_config

ALL_LANGUAGES=(holochain activitypub atproto nostr matrix solid ipfs hypercore git)

# ─── Argument parsing ────────────────────────────────────────────────────────

selected_language=""
list_only=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --language|-l)
            selected_language="$2"
            shift 2
            ;;
        --list)
            list_only=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--language <name>] [--list]"
            echo ""
            echo "Options:"
            echo "  --language, -l <name>  Run tests for a single language"
            echo "  --list                 List available language tests"
            echo "  --help, -h             Show this help"
            echo ""
            echo "Available languages: ${ALL_LANGUAGES[*]}"
            echo ""
            echo "Environment:"
            echo "  CONFIG_FILE            Path to config file (default: ./config.env)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Run $0 --help for usage" >&2
            exit 1
            ;;
    esac
done

if [[ "$list_only" == true ]]; then
    echo "Available language tests:"
    for lang in "${ALL_LANGUAGES[@]}"; do
        local_script="$SCRIPT_DIR/languages/test-${lang}.sh"
        if [[ -x "$local_script" ]]; then
            echo "  ✅ $lang"
        else
            echo "  ❌ $lang (script not found)"
        fi
    done
    exit 0
fi

# ─── Determine which languages to test ───────────────────────────────────────

languages_to_run=()

if [[ -n "$selected_language" ]]; then
    # Single language mode
    languages_to_run=("$selected_language")
elif [[ "${LANGUAGES_TO_TEST:-all}" == "all" ]]; then
    languages_to_run=("${ALL_LANGUAGES[@]}")
else
    # Parse comma-separated list
    IFS=',' read -ra languages_to_run <<< "$LANGUAGES_TO_TEST"
fi

# ─── Verify executors are running ────────────────────────────────────────────

echo "=== AD4M Link Language Integration Tests ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Device A: $DEVICE_A_HOST:$DEVICE_A_PORT"
echo "Device B: $DEVICE_B_HOST:$DEVICE_B_PORT"
echo "Languages: ${languages_to_run[*]}"
echo ""

echo "Checking executor connectivity..."
if ! wait_executor "$DEVICE_A_HOST" "$DEVICE_A_PORT" "$DEVICE_A_ADMIN" 5; then
    echo "ERROR: Device A executor not reachable. Run ./scripts/setup-executor.sh first." >&2
    exit 1
fi
if ! wait_executor "$DEVICE_B_HOST" "$DEVICE_B_PORT" "$DEVICE_B_ADMIN" 5; then
    echo "ERROR: Device B executor not reachable. Run ./scripts/setup-executor.sh first." >&2
    exit 1
fi
echo ""

# ─── Run tests ───────────────────────────────────────────────────────────────

total_pass=0
total_fail=0
total_skip=0
summary=()

for lang in "${languages_to_run[@]}"; do
    lang=$(echo "$lang" | tr -d ' ')  # trim whitespace
    test_script="$SCRIPT_DIR/languages/test-${lang}.sh"

    if [[ ! -x "$test_script" ]]; then
        echo "⚠️  No test script for '$lang' (expected $test_script)"
        echo ""
        continue
    fi

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    # Run test in a subshell to isolate failures
    if "$test_script"; then
        status="PASS"
    else
        status="FAIL"
    fi

    # Read results from the latest results file for this language
    latest_result=$(find "$RESULTS_DIR" -maxdepth 1 -name "${lang}-*.json" -print 2>/dev/null | sort -r | head -1)
    if [[ -n "$latest_result" ]]; then
        p=$(jq -r '.passed // 0' "$latest_result")
        f=$(jq -r '.failed // 0' "$latest_result")
        s=$(jq -r '.skipped // 0' "$latest_result")
        total_pass=$((total_pass + p))
        total_fail=$((total_fail + f))
        total_skip=$((total_skip + s))
        summary+=("$(printf "  %-15s %s (✅%d ❌%d ⏭️%d)" "$lang" "$status" "$p" "$f" "$s")")
    else
        summary+=("$(printf "  %-15s %s (no results file)" "$lang" "$status")")
    fi
    echo ""
done

# ─── Summary ─────────────────────────────────────────────────────────────────

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "=== Test Summary ==="
echo ""
for line in "${summary[@]}"; do
    echo "$line"
done
echo ""
echo "Total: ✅ $total_pass passed, ❌ $total_fail failed, ⏭️ $total_skip skipped"
echo ""

if [[ $total_fail -gt 0 ]]; then
    echo "❌ Some tests failed"
    exit 1
else
    echo "✅ All tests passed"
    exit 0
fi
