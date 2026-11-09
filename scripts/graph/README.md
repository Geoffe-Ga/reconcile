# Knowledge Graph (graphify)

Two queryable graphs of this repo, built by [graphify](https://pypi.org/project/graphifyy/). Ported from the adepthood repository.

- **Code graph** (`graph.json`): code only, from tree-sitter ASTs. No LLM calls, no API keys, no cost.
- **Docs graph** (`docs-graph.json`): the product docs in `docs/`, extracted by graphify's LLM layer through Claude Code. Ask it product and decision questions.

They're kept apart: merging would re-prefix every code node id, and the code graph's nightly forced rebuild would re-send every doc to the LLM.

## Get the graphs

| Command | What it does |
|---|---|
| `./scripts/graph/restore.sh` | Download both published graphs of `main` (needs an authenticated `gh`). Fastest. |
| `./scripts/graph/build.sh` | Build the code graph from scratch (installs the pinned `graphifyy` if the CLI is missing). |
| `./scripts/graph/update.sh` | Re-extract only changed code files after you edit code. |
| `./scripts/graph/build-docs.sh` | Build the docs graph. Needs the Claude Code CLI (`claude`), signed in. Later runs send only changed docs, but the first run on a machine sends all of `docs/` (about 11 calls), so prefer `restore.sh`. |

Output lands in `graphify-out/` (gitignored). Set `GRAPHIFY_FORCE=1` on `build.sh` or `update.sh` after deleting files, so graphify's shrink guard accepts the smaller graph. `build-docs.sh` doesn't need it: every docs build starts fresh from the semantic cache, so deleted docs simply drop out. `GRAPHIFY_FORCE=1` there re-sends every doc instead.

## Query it

```bash
graphify query "which module computes the tally?"
graphify path "RecapError" "main"
graphify explain "build_recap"
graphify affected "stats.merge_rate"

graphify query "what decides whether a proposal passes?" --graph graphify-out/docs-graph.json
```

Quote each node's `source_location` (code) or `source_file` (docs) when you cite the graph. Docs `source_file` paths are relative to `docs/`, so prefix `docs/` to open them. The docs graph is an index: confirm the answer in the doc it points to.

## What's in each graph

- **Code graph:** Python, TypeScript, and shell. Markdown isn't extracted.
- **Docs graph:** `docs/`: the vision docs and slide images in `docs/plan/`, the ADRs, the specs, and `use-cases.md`. Each doc becomes a node with a short rationale, plus the concepts and cross-references the model finds.
- **Local-only drafts never enter either graph.** `docs/plan/git-issues/` and `docs/prompts/` are gitignored, so CI never sees them, and graphify honors `.gitignore` locally. `.graphifyignore` lists them again as a second layer, along with `.venv`, `.claude`, `client/node_modules`, `mutants`, and build output. `build-docs.sh` also refuses to write a docs graph that names either path.
- The published graphs are release assets of this private repo, readable only by people who can read the repo.

## Cost, limits, and privacy (docs graph)

- **The LLM runs only when docs change.** graphify's semantic cache is keyed on each doc's content, so an unchanged doc never reaches the LLM again. The workflow keeps that cache between runs with `actions/cache`.
- **It draws on the same Claude subscription as the review bot** (`CLAUDE_CODE_OAUTH_TOKEN`, model sonnet), and that weekly limit has been hit before. A push touching a few docs is one `claude -p` call. A full rebuild of `docs/` is about 11 calls (around 7 minutes). Full rebuilds happen on the first run, after `actions/cache` evicts an entry unused for 7 days, or when someone dispatches the workflow with `full_rebuild`.
- **Locally, `build-docs.sh` bills whatever your `claude` uses:** `ANTHROPIC_API_KEY` when it's set (pay-as-you-go), otherwise your signed-in subscription.
- **Depth versus calls:** `build-docs.sh` packs docs into 8k-token chunks, one call each. Bigger chunks mean fewer calls, but the model then writes about one node per doc. Pass `--token-budget N` to change it.
- **Privacy:** docs go to Anthropic through Claude Code, the same provider that already reviews every PR diff. Never the local-only drafts.
- **Hardening:** `build-docs.sh` puts a `claude` wrapper first on `PATH` that adds `--restricted --strict-mcp-config` to every call graphify makes, and runs it from an empty directory with `CLAUDE_CODE_SAFE_MODE=1`. No user, project, or local settings load, so a laptop's allow rules and hooks don't apply, and neither do `CLAUDE.md`, plugins, or MCP servers. Bash and WebFetch are removed, and Read reaches only the empty directory and the slide-image folders. Checked against a permissive user settings file: without the wrapper the model read a file outside the directory; with it, both Bash and that read were denied. The residual risk is the model reading slide images, and the docs are trusted: they merge through reviewed PRs.
- **CI tokens:** the OAuth token is only in the extraction step, and the graph toolchain there installs from hash-locked wheels (`scripts/graph/requirements.lock`). That job's `GITHUB_TOKEN` is read-only. A separate publish job, which runs only `gh`, holds the write token.

## How it's published

- `.github/workflows/graph-build.yml` (code) runs on code pushes to `main` (incremental), nightly at 04:40 UTC (full rebuild), and on manual dispatch. It uploads `graph.json` and `graph-meta.json`.
- `.github/workflows/graph-docs.yml` (docs) runs on pushes to `main` that touch `docs/`, and on manual dispatch. It never runs on a schedule or a pull request. It uploads `docs-graph.json` and `docs-graph-meta.json`.

Both upload to the rolling `knowledge-graph` release and share one concurrency group, so uploads never overlap. GitHub keeps one pending run per group, so a newer code-graph run can replace a docs run that's still waiting, and it shows as cancelled. Dispatch the docs workflow to catch up.

Left out from adepthood: the LLM layer for code (code stays AST-only), the benchmark ledger, the hook guard, and the failure-reporting workflow.

## Upgrading

- **graphify:** change the single pin in `scripts/graph/requirements.txt`, then regenerate `scripts/graph/requirements.lock` with the `uv pip compile` command at its top, moving `--exclude-newer` to two weeks back. The docs workflow fails until the two agree. Both workflows' cache keys follow the pin. It's kept apart from `requirements-dev.txt` because the quality gates don't need it, and installing the tree-sitter toolchain in every CI job would slow them down.
- **Claude Code (CI):** change `CLAUDE_CODE_VERSION` in `graph-docs.yml`.
