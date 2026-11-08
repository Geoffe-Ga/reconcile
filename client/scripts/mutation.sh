#!/usr/bin/env bash
# scripts/mutation.sh - Run mutation tests with StrykerJS
# Usage: ./scripts/mutation.sh [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Run mutation tests with StrykerJS and enforce the minimum score.

Mutation testing introduces small changes (mutations) to your code
to verify that your test suite catches them. A high mutation score
indicates effective tests.

The 80% threshold is single-sourced in stryker.conf.json
(thresholds.break); Stryker exits non-zero when the mutation score
falls below it. Stryker uses one exit code for threshold failures
and run errors alike, so this gate reports both as failure.

OPTIONS:
    --verbose           Show detailed output
    --help              Display this help message

EXIT CODES:
    0                   Mutation score meets the configured threshold
    1                   Score below threshold, or Stryker run failed
    2                   StrykerJS is not installed

QUALITY STANDARDS:
    MAXIMUM QUALITY:    80% minimum mutation score
EOF
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 2
            ;;
    esac
done

cd "$PROJECT_ROOT"

if $VERBOSE; then
    set -x
fi

# Fail loudly when StrykerJS is missing — never a silent pass.
# --no-install keeps npx from fetching packages on the fly.
if ! npx --no-install stryker --version > /dev/null 2>&1; then
    echo "Error: StrykerJS is not installed" >&2
    echo "Install with: npm install --save-dev @stryker-mutator/core" \
        "@stryker-mutator/vitest-runner" >&2
    exit 2
fi

echo "=== Running Mutation Tests (StrykerJS) ==="
echo "Threshold: thresholds.break in stryker.conf.json (80%)"
echo ""

npx --no-install stryker run || {
    echo "✗ Mutation testing failed (score below threshold," \
        "or Stryker error above)" >&2
    exit 1
}

echo "✓ Mutation score meets the configured threshold"
exit 0
