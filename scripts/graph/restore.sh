#!/usr/bin/env bash
# scripts/graph/restore.sh: fetch the published graphs instead of building them.
#
# Downloads graph.json and graph-meta.json (code), plus docs-graph.json and
# docs-graph-meta.json (docs) when published, from the rolling `knowledge-graph`
# release into graphify-out/. The repo is private, so this uses the GitHub CLI
# (`gh`, already authenticated) rather than an anonymous download. Fail-soft:
# when gh is missing or a graph isn't published yet, it says so and exits 0, and
# you can run ./scripts/graph/build.sh (or build-docs.sh) instead.
#
# Usage: ./scripts/graph/restore.sh

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
OUT_DIR="$REPO_ROOT/graphify-out"
GRAPH_TAG="knowledge-graph"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh not found; build locally with ./scripts/graph/build.sh"
  exit 0
fi

mkdir -p "$OUT_DIR"
if (cd "$REPO_ROOT" && gh release download "$GRAPH_TAG" \
  --pattern graph.json --pattern graph-meta.json --dir "$OUT_DIR" --clobber); then
  echo "restored the published graph into $OUT_DIR"
  if [[ -f "$OUT_DIR/graph-meta.json" ]]; then
    cat "$OUT_DIR/graph-meta.json"
  fi
else
  echo "no published graph yet; build locally with ./scripts/graph/build.sh"
fi

if (cd "$REPO_ROOT" && gh release download "$GRAPH_TAG" \
  --pattern docs-graph.json --pattern docs-graph-meta.json --dir "$OUT_DIR" --clobber); then
  echo "restored the published docs graph into $OUT_DIR"
  if [[ -f "$OUT_DIR/docs-graph-meta.json" ]]; then
    cat "$OUT_DIR/docs-graph-meta.json"
  fi
else
  echo "no published docs graph yet; build locally with ./scripts/graph/build-docs.sh (needs the claude CLI)"
fi
