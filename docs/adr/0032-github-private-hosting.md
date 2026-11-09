# ADR-0032: Code Lives in a Private GitHub Repository

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-remaining`, decision `code-hosting`

## Decision

The code, the issues, and CI live in a **private GitHub repository** under the founder's account.

## Why

- The repository holds no member data: only code, ADRs, and the spec. Being local-first (ADR-0001) means a host compromise exposes source, not people.
- Everything is already built for GitHub: `ci.yml`, the `code-review.yml` verdict workflow, and the `gh`-based skills.
- Codeberg was ruled out because its terms require free and open-source licenses, and ours is source-available (ADR-0024).

## Consequences

- The repository stays private until publication (ADR-0024). No LICENSE file until then.
- `code-review.yml` needs an `ANTHROPIC_API_KEY` repository secret, which only the founder can provision.
- Private-repo Actions minutes are metered. The path-routed CI (`scripts/changed-areas.sh`) keeps runs small.
- Moving later is cheap: git history and issues export.
- `docs/plan/git-issues/` (issue drafts) and `docs/prompts/` stay gitignored. **Amended 2026-11-08** at the founder's direction: the vision docs in `docs/plan/` are committed, so collaborating agents and graphify can read them.
