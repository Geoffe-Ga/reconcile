#!/usr/bin/env bash
# scripts/format.sh - Format code with Black and isort
# Usage: ./scripts/format.sh [--fix] [--check] [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

CHECK=false
VERBOSE=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --fix)
            # Fixing is the default; the flag is accepted for symmetry with --check.
            CHECK=false
            shift
            ;;
        --check)
            CHECK=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Format code using Ruff (formatter + import sorting).

OPTIONS:
    --fix       Apply formatting changes (default)
    --check     Check only, fail if changes needed
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           Code is properly formatted
    1           Formatting issues found
    2           Error running checks

EXAMPLES:
    $(basename "$0") --fix         # Apply formatting
    $(basename "$0") --check       # Check only
    $(basename "$0") --verbose     # Show detailed output
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

# Set verbosity
if $VERBOSE; then
    set -x
fi

echo "=== Formatting (Ruff) ==="

# Ruff is the only formatter: the same pinned version runs here, in
# pre-commit, and in CI (requirements-dev.txt). Import order is ruff's "I" rule.
if $CHECK; then
    MODE="--check"
    ruff check --select I . || { echo "✗ Import order is wrong (run ./scripts/format.sh)" >&2; exit 1; }
    ruff format --check . || { echo "✗ Formatting check failed (run ./scripts/format.sh)" >&2; exit 1; }
else
    MODE=""
    ruff check --select I --fix . || { echo "✗ Import sorting failed" >&2; exit 1; }
    ruff format . || { echo "✗ Formatting failed" >&2; exit 1; }
fi

if [ -n "$MODE" ]; then
    echo "✓ Code formatting check passed"
else
    echo "✓ Code formatted successfully"
fi
exit 0
