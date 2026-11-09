# Knowledge Graph (graphify)

A queryable, code-only graph of this repo, built by [graphify](https://pypi.org/project/graphifyy/) from tree-sitter ASTs. No LLM calls, no API keys, no cost. Ported from the adepthood repository.

## Get the graph

| Command | What it does |
|---|---|
| `./scripts/graph/restore.sh` | Download the published graph of `main` (needs an authenticated `gh`). Fastest. |
| `./scripts/graph/build.sh` | Build from scratch (installs the pinned `graphifyy` if the CLI is missing). |
| `./scripts/graph/update.sh` | Re-extract only changed files after you edit code. |

Output lands in `graphify-out/` (gitignored). Set `GRAPHIFY_FORCE=1` on `build.sh` or `update.sh` after deleting files, so graphify's shrink guard accepts the smaller graph.

## Query it

```bash
graphify query "which module computes the tally?"
graphify path "RecapError" "main"
graphify explain "build_recap"
graphify affected "stats.merge_rate"
```

Quote each node's `source_location` when you cite the graph.

## What's in it

- Code only (Python, TypeScript, shell). Markdown and other docs aren't extracted.
- **Local-only drafts never enter the graph.** `docs/plan/git-issues/` and `docs/prompts/` are gitignored, so CI never sees them, and graphify honors `.gitignore` locally. `.graphifyignore` lists them again as a second layer, along with `.venv`, `.claude`, `client/node_modules`, `mutants`, and build output.
- The vision docs in `docs/plan/` are committed and readable, but graphify extracts Markdown only through its LLM layer, which this build leaves out. Until that's turned on, read them directly.
- The published graph is a release asset of this private repo, readable only by people who can read the repo.

## How it's published

`.github/workflows/graph-build.yml` runs on code pushes to `main` (incremental), nightly at 04:40 UTC (full rebuild), and on manual dispatch. It uploads `graph.json` and `graph-meta.json` to the rolling `knowledge-graph` release.

Left out from adepthood: the LLM semantic layer (it needs an Anthropic key and sends code to a third party), the benchmark ledger, the hook guard, and the failure-reporting workflow.

## Upgrading graphify

Change the single pin in `scripts/graph/requirements.txt`. The workflow's cache key follows it. It's kept apart from `requirements-dev.txt` because the quality gates don't need it, and installing the tree-sitter toolchain in every CI job would slow them down.
