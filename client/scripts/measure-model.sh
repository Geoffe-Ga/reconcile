#!/usr/bin/env bash
# scripts/measure-model.sh - Serve the model-measuring page to a phone on this network (#476).
#
# Builds the test-only page e2e/bedfellows-model/ with the real model's files
# (fetched by scripts/models.sh first) into a temp directory, then serves it
# with `vite preview` and the deploy CSP on every address of this machine, so
# a phone on the same Wi-Fi can open it. The page's Measure button downloads
# the model from this machine and shows the numbers ADR-0080 §8 budgets.
# Nothing leaves the phone but requests to this machine.
#
# Usage: scripts/measure-model.sh [--port PORT] [--help]
#   --port PORT   the port to serve on (default 4180)
set -euo pipefail
cd "$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"

port=4180
while [[ $# -gt 0 ]]; do
    case $1 in
        --port) port="${2:?--port needs a number}"; shift 2 ;;
        --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Error: Unknown option: $1" >&2; exit 2 ;;
    esac
done
[[ "$port" =~ ^[0-9]+$ ]] || { echo "Error: --port needs a number" >&2; exit 2; }

./scripts/models.sh
out="$(mktemp -d "${TMPDIR:-/tmp}/reconcile-measure-model-XXXXXX")"
trap 'rm -rf "$out"' EXIT
RECONCILE_MODELS=required npx vite build e2e/bedfellows-model --config vite.config.ts \
    --outDir "$out" --emptyOutDir --logLevel warn
echo ""
echo "Open one of these on the phone, on the same Wi-Fi, and press Measure:"
npx vite preview e2e/bedfellows-model --config vite.config.ts --outDir "$out" \
    --host 0.0.0.0 --port "$port" --strictPort
