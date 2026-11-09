#!/usr/bin/env bash
# scripts/graph/build-docs.sh: build the docs knowledge graph with graphify's LLM layer.
#
# Extracts docs/ (the vision docs and slide images in docs/plan, the ADRs, the
# specs, and use-cases.md) through Claude Code (`claude -p`, graphify's
# claude-cli backend) and writes graphify-out/docs-graph.json. Only docs whose
# content changed since the last run reach the LLM: graphify's semantic cache
# persists in graphify-out/docs-build/cache/semantic. docs/plan/git-issues and
# docs/prompts never enter the graph (.gitignore and .graphifyignore), and the
# script refuses to write a graph that names either.
#
# Usage: ./scripts/graph/build-docs.sh [extra graphify args...]
# Env:   GRAPHIFY_CLAUDE_CLI_MODEL  model for `claude -p` (default: sonnet)
#        GRAPHIFY_FORCE=1           skip the cache and re-send every doc

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
DOCS_DIR="$REPO_ROOT/docs"
OUT_DIR="$REPO_ROOT/graphify-out"
BUILD_DIR="$OUT_DIR/docs-build"

ensure_graphify() {
  if command -v graphify >/dev/null 2>&1; then
    return
  fi
  echo "graphify CLI not found; installing the pinned toolchain into the active environment..."
  python3 -m pip install -r "$SCRIPT_DIR/requirements.txt"
}

require_claude() {
  if command -v claude >/dev/null 2>&1; then
    return
  fi
  echo "error: the docs graph needs the Claude Code CLI (\`claude\`) on PATH." >&2
  echo "Install it, run \`claude\` once to sign in, then re-run. The code graph needs no LLM: ./scripts/graph/build.sh" >&2
  exit 1
}

# Start each build fresh, keeping only the semantic cache (the part that costs
# LLM calls). Deleted docs then drop out cleanly, and graphify's shrink guard
# never compares against a stale graph.
reset_build_dir() {
  mkdir -p "$BUILD_DIR/cache"
  find "$BUILD_DIR" -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} +
  find "$BUILD_DIR/cache" -mindepth 1 -maxdepth 1 ! -name semantic -exec rm -rf {} +
}

# Fail on a leaked local-only draft, then print node and edge counts.
check_and_count() {
  python3 - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    graph = json.load(handle)
items = graph.get("nodes", []) + (graph.get("links") or graph.get("edges") or [])
items += graph.get("hyperedges", [])
leaked = sorted(
    {
        str(item.get("source_file", ""))
        for item in items
        if str(item.get("source_file", "")).startswith(("plan/git-issues/", "prompts/"))
    }
)
if leaked:
    print(f"error: local-only drafts reached the docs graph: {leaked[:5]}", file=sys.stderr)
    sys.exit(1)
node_count = len(graph.get("nodes", []))
edge_count = len(graph.get("links") or graph.get("edges") or [])
print(f"{node_count:,} nodes / {edge_count:,} edges")
PY
}

ensure_graphify
require_claude
reset_build_dir

# Run from an empty directory so `claude -p` loads no repo CLAUDE.md or
# .claude/ settings. Safe mode also skips hooks, plugins, MCP servers, and
# skills, so every call is just the extraction prompt.
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir "$WORK_DIR/cwd" "$WORK_DIR/bin"
LOG="$WORK_DIR/extract.log"

# graphify runs the bare `claude` from PATH, so a wrapper first on PATH adds the
# lockdown flags to every call. --restricted ignores user, project, and local
# settings (a laptop's allow rules never apply), removes Bash and WebFetch, and
# confines Read to the empty cwd and the slide-image folders graphify passes
# with --add-dir. --strict-mcp-config loads no MCP servers.
printf '#!/usr/bin/env bash\nexec %q --restricted --strict-mcp-config "$@"\n' \
  "$(command -v claude)" >"$WORK_DIR/bin/claude"
chmod +x "$WORK_DIR/bin/claude"
export PATH="$WORK_DIR/bin:$PATH"

export CLAUDE_CODE_SAFE_MODE=1
export GRAPHIFY_CLAUDE_CLI_MODEL="${GRAPHIFY_CLAUDE_CLI_MODEL:-sonnet}"
export GRAPHIFY_OUT="$BUILD_DIR"
export PYTHONUNBUFFERED=1  # stream chunk progress through tee

# graphify packs docs into one `claude -p` call per chunk, and the model writes
# about one node per doc when a chunk holds dozens. The default 60k-token chunk
# fits all of docs/ in 2 calls but leaves most ADRs a single node; 8k makes a
# full rebuild about 11 calls with deeper extraction. A push touching a few docs
# stays at 1 call. A later --token-budget in the arguments wins.
echo "Building docs graph for $DOCS_DIR (claude-cli, model $GRAPHIFY_CLAUDE_CLI_MODEL) ..."
(cd "$WORK_DIR/cwd" && graphify extract "$DOCS_DIR" --backend claude-cli --out "$BUILD_DIR" \
  --token-budget 8000 "$@") 2>&1 | tee "$LOG"

# A chunk lost to a rate limit or a hollow reply still exits 0 on a fresh
# build. Publish nothing partial. Finished chunks are already cached, so a
# re-run sends only the rest.
if grep -Eq 'chunk [0-9]+/[0-9]+ failed|semantic extraction (failed|is incomplete)' "$LOG"; then
  echo "error: the docs extraction was incomplete (see above); re-run to retry only the missing docs." >&2
  exit 1
fi
if [[ ! -f "$BUILD_DIR/graph.json" ]]; then
  echo "error: $BUILD_DIR/graph.json missing after extraction" >&2
  exit 1
fi

check_and_count "$BUILD_DIR/graph.json"
cp "$BUILD_DIR/graph.json" "$OUT_DIR/docs-graph.json"
echo "wrote $OUT_DIR/docs-graph.json"
