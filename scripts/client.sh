#!/usr/bin/env bash
# scripts/client.sh - Run the TypeScript client's own quality gate from the repo root.
# Usage: ./scripts/client.sh [--verbose]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")/client"
if [[ ! -d node_modules ]]; then
    npm ci
fi
exec ./scripts/check-all.sh "$@"
