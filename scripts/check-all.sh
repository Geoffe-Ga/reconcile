#!/usr/bin/env bash
# scripts/check-all.sh - Run all quality checks
# Usage: ./scripts/check-all.sh [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

VERBOSE=false
AREAS_FLAG=""
FORCE_AREAS=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose)
            VERBOSE=true
            shift
            ;;
        --all)
            AREAS_FLAG="--all"
            shift
            ;;
        --python)
            FORCE_AREAS="python=true client=false"
            shift
            ;;
        --client)
            FORCE_AREAS="python=false client=true"
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Run the quality checks for every area the current change touches
(see scripts/changed-areas.sh): Python checks when reconcile/, tests/, or
Python config changed; client checks when client/ changed; both when shared
tooling or protocol/ changed. Docs-only changes run nothing.

Python checks:
  1. Linting (Ruff + interrogate docstring coverage)
  2. Formatting (Ruff)
  3. Type checking (MyPy)
  4. Security checks (Bandit + pip-audit)
  5. Complexity analysis (Radon + Xenon)
  6. Unit tests
  7. Coverage (lines >= 90%, branches >= 85%)
  8. Build (sdist + wheel, twine check)

CI runs this same script (--python / --client), plus pre-commit, so the
rules can't differ between a laptop and CI.

OPTIONS:
    --all       Check every area regardless of what changed
    --python    Check only the Python area (CI's Python job uses this)
    --client    Check only the client area (CI's client job uses this)
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           All checks passed
    1           One or more checks failed
    2           Error running checks

EXAMPLES:
    $(basename "$0")          # Run all checks
    $(basename "$0") --verbose # Show detailed output
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
VERBOSE_FLAG=""
if $VERBOSE; then
    VERBOSE_FLAG="--verbose"
fi

echo "=== Running All Quality Checks ==="
echo ""

FAILED_CHECKS=()
PASSED_CHECKS=()

# Helper function to run a check
run_check() {
    local check_name=$1
    local script=$2
    shift 2
    local args=("$@")

    echo "Running: $check_name"
    if "$SCRIPT_DIR/$script" "${args[@]+"${args[@]}"}" $VERBOSE_FLAG; then
        PASSED_CHECKS+=("$check_name")
        echo "✓ $check_name passed"
    else
        FAILED_CHECKS+=("$check_name")
        echo "✗ $check_name failed" >&2
    fi
    echo ""
}

AREAS="${FORCE_AREAS:-$("$SCRIPT_DIR/changed-areas.sh" $AREAS_FLAG)}"
echo "Changed areas: ${AREAS//$'\n'/ }"
echo ""

if [[ "$AREAS" == *"python=true"* ]]; then
    run_check "Linting" "lint.sh" --check
    run_check "Formatting" "format.sh" --check
    run_check "Type checking" "typecheck.sh"
    run_check "Security checks" "security.sh"
    run_check "Complexity analysis" "complexity.sh"
    run_check "Unit tests" "test.sh" --unit
    run_check "Coverage report" "coverage.sh"
    run_check "Build" "build.sh"
fi

if [[ "$AREAS" == *"client=true"* ]]; then
    run_check "Client (TypeScript)" "client.sh"
fi

if [ ${#PASSED_CHECKS[@]} -eq 0 ] && [ ${#FAILED_CHECKS[@]} -eq 0 ]; then
    echo "No code areas changed; nothing to check. Run with --all to force every check."
fi

echo "=== Quality Checks Summary ==="
echo "Passed: ${#PASSED_CHECKS[@]}"
echo "Failed: ${#FAILED_CHECKS[@]}"

if [ ${#FAILED_CHECKS[@]} -gt 0 ]; then
    echo ""
    echo "Failed checks:"
    for check in "${FAILED_CHECKS[@]}"; do
        echo "  ✗ $check"
    done
    exit 1
else
    echo ""
    echo "✓ All quality checks passed!"
    exit 0
fi
