#!/usr/bin/env bash
# test-nextgraph.sh — NextGraph Link Language integration test
# Infrastructure: NextGraph sidecar gateway (Node.js, NOT Docker)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$SCRIPT_DIR/../common.sh"
load_config

GATEWAY_PID=""
GATEWAY_PORT="${NEXTGRAPH_PORT:-7779}"
GATEWAY_URL="http://${DEVICE_A_HOST:-127.0.0.1}:${GATEWAY_PORT}"
GATEWAY_DIR="${NEXTGRAPH_GATEWAY_DIR:-}"
GATEWAY_STORAGE="/tmp/nextgraph-gateway-data-$$"

setup_nextgraph_infra() {
    echo "  Setting up NextGraph gateway..."

    # Find gateway directory
    if [[ -z "$GATEWAY_DIR" ]]; then
        # Try common locations
        for dir in \
            "$REPO_DIR/../nextgraph-link-language/gateway" \
            "/tmp/nextgraph-link-language/gateway" \
            "$HOME/workspaces/hexafield/nextgraph-link-language/gateway"; do
            if [[ -d "$dir" ]]; then
                GATEWAY_DIR="$dir"
                break
            fi
        done
    fi

    if [[ -z "$GATEWAY_DIR" || ! -d "$GATEWAY_DIR" ]]; then
        echo "  ERROR: NextGraph gateway directory not found"
        echo "  Set NEXTGRAPH_GATEWAY_DIR or clone nextgraph-link-language"
        return 1
    fi

    # Install deps if needed
    if [[ ! -d "$GATEWAY_DIR/node_modules" ]]; then
        echo "  Installing gateway dependencies..."
        (cd "$GATEWAY_DIR" && npm install --silent) || return 1
    fi

    # Create temp storage
    mkdir -p "$GATEWAY_STORAGE"

    # Start gateway
    echo "  Starting NextGraph gateway on port $GATEWAY_PORT..."
    PORT="$GATEWAY_PORT" STORAGE_PATH="$GATEWAY_STORAGE" \
        npx tsx "$GATEWAY_DIR/index.ts" &>/tmp/nextgraph-gateway.log &
    GATEWAY_PID=$!

    # Wait for gateway to be ready
    local tries=0
    while ! curl -sf "$GATEWAY_URL/status" >/dev/null 2>&1; do
        sleep 1
        tries=$((tries + 1))
        if [[ $tries -ge 30 ]]; then
            echo "  ERROR: Gateway did not start within 30s"
            echo "  Logs:"
            tail -20 /tmp/nextgraph-gateway.log
            return 1
        fi
    done
    echo "  NextGraph gateway ready at $GATEWAY_URL"

    # Initialize wallet
    curl -sf -X POST "$GATEWAY_URL/wallet/init" \
        -H "Content-Type: application/json" \
        -d "{\"storagePath\": \"$GATEWAY_STORAGE\"}" >/dev/null 2>&1 || true
}

teardown_nextgraph_infra() {
    echo "  Tearing down NextGraph gateway..."
    if [[ -n "$GATEWAY_PID" ]]; then
        kill "$GATEWAY_PID" 2>/dev/null || true
        wait "$GATEWAY_PID" 2>/dev/null || true
    fi
    rm -rf "$GATEWAY_STORAGE" 2>/dev/null || true
}

run_standard_tests "nextgraph" "${LANG_NEXTGRAPH:-}" setup_nextgraph_infra teardown_nextgraph_infra
