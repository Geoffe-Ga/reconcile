#!/usr/bin/env bash
# scripts/tracked.sh - Fail when git ignores a file in client/ that isn't build output.
# CI checks out only what git tracks. A source file that a .gitignore rule
# happens to match exists on the machine that wrote it, so every local gate
# passes, and then it's missing in CI: the root's Python `build/` rule once
# hid client/build/, and with it the service worker plugin (#76). Only the
# tools' own output, the client section of the root .gitignore, may be ignored.
set -euo pipefail
cd "$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
echo "=== Tracked sources (git) ==="
# Output the client's tools write; nothing in these is a source.
GENERATED='^(node_modules|dist|coverage|reports|\.stryker-tmp|test-results)/'
listed="$(git ls-files --others --ignored --exclude-standard --directory -- .)" \
    || { echo "✗ git couldn't list ignored files; run this inside the repository" >&2; exit 1; }
ignored="$(grep -Ev "$GENERATED" <<< "$listed" || true)"
if [[ -n "$ignored" ]]; then
    echo "✗ git ignores these, so CI's checkout won't have them:" >&2
    while IFS= read -r path; do
        echo "    $path" >&2
    done <<< "$ignored"
    echo "  Move them out of the ignored path, or add the directory to GENERATED here" >&2
    echo "  only if a tool writes it." >&2
    exit 1
fi
echo "✓ Everything under client/ is tracked or build output"
