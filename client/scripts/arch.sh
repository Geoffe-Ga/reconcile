#!/usr/bin/env bash
# scripts/arch.sh - Enforce module boundaries with dependency-cruiser.
# engine/, crypto/, and store/ must never import React or UI code (ADR-0022).
set -euo pipefail
cd "$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
echo "=== Architecture (dependency-cruiser) ==="
npx --no-install depcruise --config plans/architecture/.dependency-cruiser.cjs src \
    || { echo "✗ Architecture rules violated" >&2; exit 1; }
echo "✓ Architecture rules hold"
