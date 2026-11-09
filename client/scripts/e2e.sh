#!/usr/bin/env bash
# scripts/e2e.sh - Run the end-to-end loop (Playwright) through the real relay
# Usage: ./scripts/e2e.sh [--verbose] [--help] [PLAYWRIGHT_ARGS...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

VERBOSE=false
PLAYWRIGHT_ARGS=()

while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS] [PLAYWRIGHT_ARGS...]

Build the app, then run e2e/ with Playwright. playwright.config.ts starts the
relay (../scripts/relay.sh) and "vite preview" of the build, which sends the
deploy CSP, and stops both when the run ends.

Each run gets two free loopback ports (E2E_WEB_PORT, RECONCILE_RELAY_PORT)
and a relay database (RECONCILE_RELAY_DB) in a new temp directory, which is
deleted when the script exits, pass or fail.

Any other argument goes to "playwright test", for example:
    $(basename "$0") --project=chromium
    $(basename "$0") --grep nomatch     # exits non-zero: no test matched

ENVIRONMENT:
    E2E_PROJECTS   Space-separated Playwright projects to run (default: all,
                   which is chromium and webkit). For a machine without
                   WebKit only; CI always runs every project.

OPTIONS:
    --verbose   Show each command as it runs
    --help      Display this help message

EXIT CODES:
    0           The loop passed in every browser
    1+          A build or a test failed (Playwright's own exit code)
EOF
            exit 0
            ;;
        *)
            PLAYWRIGHT_ARGS+=("$1")
            shift
            ;;
    esac
done

cd "$PROJECT_ROOT"

if $VERBOSE; then
    set -x
fi

echo "=== End-to-end loop (Playwright) ==="

read -r -a PROJECTS <<< "${E2E_PROJECTS:-}"
for project in "${PROJECTS[@]+"${PROJECTS[@]}"}"; do
    PLAYWRIGHT_ARGS+=("--project=$project")
done
if [[ ${#PROJECTS[@]} -gt 0 ]]; then
    echo "Running only: ${PROJECTS[*]} (E2E_PROJECTS). CI runs every browser."
fi

# Two ports the kernel says are free now. The servers bind them a moment later
# with --strictPort (vite) or a plain bind (uvicorn), so a clash fails loudly.
read -r E2E_WEB_PORT RECONCILE_RELAY_PORT < <(python3 -c '
import socket
socks = [socket.socket() for _ in range(2)]
for sock in socks:
    sock.bind(("127.0.0.1", 0))
print(*(sock.getsockname()[1] for sock in socks))
')
export E2E_WEB_PORT RECONCILE_RELAY_PORT

# The relay's database lives only as long as this run.
E2E_TMP="$(mktemp -d)"
cleanup() { rm -rf "$E2E_TMP"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export RECONCILE_RELAY_DB="$E2E_TMP/relay.db"

if [[ ! -d node_modules ]]; then
    npm ci
fi

npm run build
npx playwright test "${PLAYWRIGHT_ARGS[@]+"${PLAYWRIGHT_ARGS[@]}"}"
