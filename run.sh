#!/usr/bin/env bash
set -euo pipefail

# AD4M Wind Tunnel — Quick Run Script
# Usage:
#   ./run.sh --branch my-feature          # Run against a single branch
#   ./run.sh --branch main --branch feat   # Compare two branches
#   ./run.sh --skip-build --executor-path /path/to/binary  # Pre-built executor
#   ./run.sh --scenario s1                 # Run specific scenario only

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║            AD4M WIND TUNNEL — Runner                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Ensure dependencies
if [ ! -d "node_modules" ]; then
  echo "[setup] Installing dependencies..."
  npm install
fi

# Run
echo "[run] Starting wind tunnel..."
npx tsx src/main.ts "$@"

echo ""
echo "[done] Results available in ./results/"
echo "       Comparison: ./results/comparison.md"
