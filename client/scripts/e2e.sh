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

Build the app, then run e2e/ with Playwright. playwright.config.ts starts
"vite preview" of the build, which sends the deploy CSP, once for each
Playwright worker. Each test starts its worker's relay (../scripts/relay.sh)
and stops it when it ends, so the relay-learns-nothing spec can scan what the
relay left behind.

Each worker gets two free loopback ports of its own (E2E_WEB_PORTS and
E2E_RELAY_PORTS list them, one per worker), and the run gets a new temp
directory (E2E_RELAY_DIR) holding each worker's relay database
(relay-N.db) and its stdout and stderr (relay-N.log). No worker touches
another's servers or files. The directory is deleted when the script exits,
pass or fail; on a failure each relay's log is printed first.

Any other argument goes to "playwright test", for example:
    $(basename "$0") --project=chromium
    $(basename "$0") --grep nomatch     # exits non-zero: no test matched

ENVIRONMENT:
    E2E_WORKERS    How many Playwright workers run tests at once, each with
                   its own servers (default: 2, as on CI's two-core runner).
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

WORKERS="${E2E_WORKERS:-2}"
if [[ ! "$WORKERS" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: E2E_WORKERS must be a whole number, 1 or more (got '$WORKERS')" >&2
    exit 2
fi

# Two ports for each worker, which the kernel says are free now: one for its
# vite preview and one for its relay. The servers bind them a moment later with
# --strictPort (vite) or a plain bind (uvicorn), so a clash fails loudly.
read -r -a PORTS < <(python3 -c '
import socket
import sys
socks = [socket.socket() for _ in range(2 * int(sys.argv[1]))]
for sock in socks:
    sock.bind(("127.0.0.1", 0))
print(*(sock.getsockname()[1] for sock in socks))
' "$WORKERS")
export E2E_WEB_PORTS="${PORTS[*]:0:WORKERS}"
export E2E_RELAY_PORTS="${PORTS[*]:WORKERS}"

# Each worker's relay database and output (relay-N.db, relay-N.log) live only
# as long as this run. The specs read both: relay-learns-nothing.spec.ts scans
# their raw bytes.
E2E_TMP="$(mktemp -d)"
export E2E_RELAY_DIR="$E2E_TMP"
cleanup() {
    local status=$? log
    if [[ $status -ne 0 ]]; then
        for log in "$E2E_TMP"/relay-*.log; do
            [[ -s "$log" ]] || continue
            echo "=== $(basename "$log"): relay output (it logs no requests) ===" >&2
            cat "$log" >&2
        done
    fi
    rm -rf "$E2E_TMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -d node_modules ]]; then
    npm ci
fi

npm run build
npx playwright test "${PLAYWRIGHT_ARGS[@]+"${PLAYWRIGHT_ARGS[@]}"}"
