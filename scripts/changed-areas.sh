#!/usr/bin/env bash
# scripts/changed-areas.sh - Decide which code areas a change touches.
#
# Prints GitHub-Actions-style lines, one per area:
#   python=true|false
#   client=true|false
#   deploy=true|false
#   e2e=true|false      (the Playwright loop: the app and the relay together)
#
# Used by scripts/check-all.sh locally and by .github/workflows/ci.yml, so the
# two can never disagree about what needs checking.
#
# Base for comparison: $BASE_REF if set (CI passes the PR base), else the
# merge-base with origin/main or main. Local uncommitted and untracked files
# are included. Fails safe: no git repo, no base, or an unrecognized path
# means every area runs.
#
# Usage: ./scripts/changed-areas.sh [--all]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"

python=false
client=false
deploy=false
e2e=false

all() { python=true; client=true; deploy=true; e2e=true; }

emit() {
    echo "python=$python"
    echo "client=$client"
    echo "deploy=$deploy"
    echo "e2e=$e2e"
}

if [[ "${1:-}" == "--all" ]]; then
    all; emit; exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || ! git rev-parse --verify --quiet HEAD >/dev/null; then
    all; emit; exit 0
fi

# An explicit base that doesn't resolve means history was rewritten (a
# force-push hands CI a "before" sha that no longer exists). Falling back to
# origin/main there would diff HEAD against itself and check nothing.
if [[ -n "${BASE_REF:-}" ]] && ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null; then
    all; emit; exit 0
fi

base=""
for candidate in "${BASE_REF:-}" origin/main main; do
    [[ -z "$candidate" ]] && continue
    if git rev-parse --verify --quiet "$candidate" >/dev/null; then
        base="$(git merge-base "$candidate" HEAD 2>/dev/null || true)"
        [[ -n "$base" ]] && break
    fi
done

if [[ -z "$base" ]]; then
    all; emit; exit 0
fi

files="$( {
    git diff --name-only "$base"...HEAD
    git diff --name-only HEAD
    git ls-files --others --exclude-standard
} | sort -u )"

while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    case "$path" in
        # The e2e loop runs the app and the relay, so a change to either runs it.
        # deploy/check.sh holds vite preview's CSP equal to the Caddyfile's.
        client/vite.config.ts)                      client=true; deploy=true; e2e=true ;;
        # tests/test_e2e_script.py checks the script that runs the loop.
        client/scripts/e2e.sh)                      client=true; python=true; e2e=true ;;
        client/*)                                   client=true; e2e=true ;;
        # Before *.md: the runbook is checked with the config it explains.
        deploy/*)                                   deploy=true ;;
        # requirements.txt is what the relay runs on; scripts/relay.sh is shared tooling.
        reconcile/*|requirements.txt)               python=true; e2e=true ;;
        # stubs/ types third-party Python packages for mypy (pyproject.toml).
        tests/*|stubs/*|pyproject.toml|requirements*.txt|.pylintrc)
                                                    python=true ;;
        # Shared contract and shared tooling: every area must re-check.
        protocol/*|scripts/*|.github/workflows/ci.yml|.pre-commit-config.yaml|.secrets.baseline)
                                                    all ;;
        # Prose and planning never need a code gate.
        docs/*|plans/*|*.md|.claude/*|.github/workflows/code-review.yml|.gitignore|.gitattributes)
                                                    ;;
        *)                                          all ;;
    esac
done <<< "$files"

emit
