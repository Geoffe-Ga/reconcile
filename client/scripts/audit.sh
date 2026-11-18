#!/usr/bin/env bash
# scripts/audit.sh - Fail on moderate-or-worse advisories in installed packages.
# On failure, follow the cve-remediation skill: upgrade first, suppress last.
#
# Production dependencies get no exception. Dev tooling may carry an advisory
# with no patched release only while it is on .npm-audit-known-vulnerabilities,
# with an expires= date at most 30 days out, which scripts/auditKnown.mjs
# enforces (#495).
set -euo pipefail
cd "$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
echo "=== Dependency audit (npm audit) ==="
npm audit --omit=dev --audit-level=moderate || {
    echo "✗ Vulnerable production dependencies: no exception applies (see cve-remediation skill)" >&2
    exit 1
}
report="$(mktemp)"
trap 'rm -f "$report"' EXIT
# npm exits non-zero whenever it reports an advisory; the known list decides.
npm audit --json --audit-level=moderate > "$report" || true
node scripts/auditKnown.mjs .npm-audit-known-vulnerabilities < "$report" || {
    echo "✗ Vulnerable dependencies (see cve-remediation skill)" >&2
    exit 1
}
echo "✓ No moderate-or-worse advisories but known, unexpired dev-tooling ones"
