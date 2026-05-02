#!/usr/bin/env bash
# setup.sh — Master setup script for AD4M interop testing
# Runs FROM local Mac, deploys services to Device A via SSH/Docker
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "AD4M Link Language Interop — Setup"

# ─── Step 1: Verify SSH to Device A ─────────────────────────────────────────

step "Testing SSH connection to Device A (${DEVICE_A_USER}@${DEVICE_A})..."
if ssh_device_a "echo ok" >/dev/null 2>&1; then
    success "SSH to Device A works"
else
    error "Cannot SSH to ${DEVICE_A_USER}@${DEVICE_A}"
    echo "  Ensure SSH key auth is configured and Device A is reachable."
    exit 1
fi

# ─── Step 2: Check Docker on Device A ───────────────────────────────────────

step "Checking Docker on Device A..."
if ssh_device_a "docker info" >/dev/null 2>&1; then
    success "Docker is available on Device A"
else
    error "Docker is not available on Device A"
    echo "  Install Docker: curl -fsSL https://get.docker.com | sh"
    exit 1
fi

# ─── Step 3: Copy docker-compose.yml and start services ─────────────────────

step "Copying docker-compose.yml to Device A..."
scp -o StrictHostKeyChecking=no "$SCRIPT_DIR/docker-compose.yml" \
    "${DEVICE_A_USER}@${DEVICE_A}:/tmp/ad4m-interop-compose.yml"
success "Compose file copied"

step "Starting Docker services on Device A..."
ssh_device_a "cd /tmp && docker compose -f ad4m-interop-compose.yml up -d" 2>&1 | while read -r line; do
    echo "  $line"
done
success "Docker services started"

# ─── Step 4: Wait for services to be healthy ────────────────────────────────

header "Waiting for services to be ready"

READY=0
TOTAL=5

# Matrix
if check_http "$MATRIX_URL/_matrix/client/versions" "Matrix (Conduit)" 30; then
    ((READY++))
fi

# AT Protocol
if check_http "$ATPROTO_URL/xrpc/_health" "AT Protocol (PDS)" 30; then
    ((READY++))
fi

# Solid
if check_http "$SOLID_URL/" "Solid (CSS)" 30; then
    ((READY++))
fi

# IPFS
if check_http "$IPFS_API/api/v0/id" "IPFS (Kubo)" 30; then
    ((READY++))
fi

# Nostr
if check_ws "$DEVICE_A" 7777 "Nostr Relay" 10; then
    ((READY++))
fi

echo ""
info "$READY/$TOTAL Docker services ready"

# ─── Step 5: Hypercore Gateway (Node.js, not Docker) ────────────────────────

header "Setting up Hypercore Gateway"

step "Checking Hypercore Gateway on Device A..."
if curl -sf --max-time 5 "$HYPERCORE_URL/status" >/dev/null 2>&1; then
    success "Hypercore Gateway already running"
else
    warn "Hypercore Gateway not running at $HYPERCORE_URL"
    info "To start it manually on Device A:"
    echo "  cd /tmp/hypercore-gateway && node index.js &"
    echo "  (See README.md for setup instructions)"
fi

# ─── Step 6: Check AD4M Executor ────────────────────────────────────────────

header "Checking AD4M Executor"
wait_executor 15 || {
    error "AD4M executor is not running"
    echo "  Start the executor on Device A, port $AD4M_PORT"
    echo "  Interop tests require a running executor."
    exit 1
}

# ─── Step 7: Verify languages are installed ─────────────────────────────────

header "Verifying Language Installations"

for lang_var in LANG_MATRIX LANG_ATPROTO LANG_SOLID LANG_IPFS LANG_NOSTR LANG_HYPERCORE; do
    lang_addr="${!lang_var}"
    lang_name="${lang_var#LANG_}"
    step "Checking $lang_name ($lang_addr)..."
    result=$(ad4m_rpc language-get "$lang_addr" 2>/dev/null) || true
    addr=$(echo "$result" | jq -r '.address // empty' 2>/dev/null) || true
    if [[ -n "$addr" && "$addr" != "null" ]]; then
        success "$lang_name language found"
    else
        warn "$lang_name language NOT found — verify-${lang_name,,}.sh may fail"
    fi
done

# ─── Done ────────────────────────────────────────────────────────────────────

header "Setup Complete"
echo "Services running on Device A ($DEVICE_A):"
echo "  • Matrix (Conduit):  $MATRIX_URL"
echo "  • AT Protocol (PDS): $ATPROTO_URL"
echo "  • Solid (CSS):       $SOLID_URL"
echo "  • IPFS (Kubo):       $IPFS_API (gateway: $IPFS_GATEWAY)"
echo "  • Nostr Relay:       $NOSTR_WS"
echo "  • Hypercore Gateway: $HYPERCORE_URL"
echo ""
echo "AD4M Executor: ws://${AD4M_HOST}:${AD4M_PORT}"
echo ""
echo "Run individual tests:"
echo "  ./verify-matrix.sh"
echo "  ./verify-atproto.sh"
echo "  ./verify-solid.sh"
echo "  ./verify-ipfs.sh"
echo "  ./verify-nostr.sh"
echo "  ./verify-hypercore.sh"
echo ""
echo "Or run all:"
echo "  for f in verify-*.sh; do ./$f; done"
