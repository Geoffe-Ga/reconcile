#!/usr/bin/env bash
# scripts/audit.sh - Fail on moderate-or-worse advisories in installed packages.
# On failure, follow the cve-remediation skill: upgrade first, suppress last.
set -euo pipefail
cd "$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
echo "=== Dependency audit (npm audit) ==="
npm audit --audit-level=moderate || { echo "✗ Vulnerable dependencies (see cve-remediation skill)" >&2; exit 1; }
echo "✓ No moderate-or-worse advisories"
