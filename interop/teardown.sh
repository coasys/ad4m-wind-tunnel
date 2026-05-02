#!/usr/bin/env bash
# teardown.sh — Clean up all interop test infrastructure
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

header "AD4M Link Language Interop — Teardown"

# ─── Remove test perspectives from executor ──────────────────────────────────

step "Cleaning up test perspectives..."
perspectives=$(ad4m_rpc perspective-all 2>/dev/null) || perspectives="[]"
echo "$perspectives" | jq -r '.[] | select(.name // "" | startswith("interop-")) | .uuid' 2>/dev/null | while read -r uuid; do
    if [[ -n "$uuid" ]]; then
        info "Removing perspective $uuid"
        ad4m_rpc perspective-remove "$uuid" >/dev/null 2>&1 || true
    fi
done
success "Test perspectives cleaned up"

# ─── Stop Docker services on Device A ────────────────────────────────────────

step "Stopping Docker services on Device A..."
if ssh_device_a "test -f /tmp/ad4m-interop-compose.yml" 2>/dev/null; then
    ssh_device_a "cd /tmp && docker compose -f ad4m-interop-compose.yml down -v" 2>&1 | while read -r line; do
        echo "  $line"
    done
    ssh_device_a "rm -f /tmp/ad4m-interop-compose.yml"
    success "Docker services stopped and volumes removed"
else
    warn "No compose file found on Device A — services may already be down"
fi

# ─── Hypercore Gateway ──────────────────────────────────────────────────────

step "Note: Hypercore Gateway is a standalone Node.js process."
info "If you want to stop it: ssh ${DEVICE_A_USER}@${DEVICE_A} 'pkill -f hypercore-gateway'"

header "Teardown Complete"
echo "All interop test infrastructure has been cleaned up."
echo "The AD4M executor was NOT stopped (it may be used for other tasks)."
