# ADR-0061: The Merge Gates; Mutation Testing Before a Release

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-dev-process`, decision `ci-scope` (the founder's own approach)

## Decision

From the founder: "Mutation only recommended before release. The gates are: TDD, check-all.sh on relevant paths, pre-commit on changed files, CI on changed files (full matrix necessary only on backend), Claude review in the repo, all must pass (with a COMMENTS verdict counting as passed but requiring a follow-up filed, and LGTM preferred)."

**Merge gates**
1. **TDD:** a failing test first.
2. **`./scripts/check-all.sh`** for the areas the change touches.
3. **Pre-commit on the changed files:** `pre-commit run --from-ref origin/main --to-ref HEAD`.
4. **CI on the changed areas.** The full Python matrix (3.11–3.13) runs only for backend changes. CI's pre-commit job runs on changed files too, and on every file when the hook config changes or no base exists.
5. **The review bot:**
   - LGTM is preferred.
   - COMMENTS can merge, but only after every finding is filed as a P0–P3 follow-up issue: file first, then merge (founder, 2026-11-08).
   - CHANGES_REQUESTED blocks.

**Mutation testing is recommended before a release, not a merge gate.** The target stays at ≥80%. Run `./scripts/mutation.sh` and `client/scripts/mutation.sh`, or CI's manual "Mutation testing" job.

## Consequences

- This replaces "the 4 gates" that green-init generated. That template made mutation score gate 3 and ran mutation on every push to main.
- `CLAUDE.md` holds the canonical gate list, and other docs link to it rather than restating thresholds. Changed together:
  - `CLAUDE.md`
  - `.claude/docs` and `client/.claude/docs` (principles, quality standards, testing, tools, workflow)
  - the stay-green, address-feedback, review-diff, bug-squashing, and spec-decomposition skills
  - `client/CLAUDE.md`, the README, spec §1 and §8, `.pre-commit-config.yaml`, and `ci.yml`
- The mutation scripts keep enforcing ≥80% when they are run, so a pre-release run fails loudly.
- *Upstream note:* the same flaw lives in the green-init template that generated this repo. Fixing it there is outside this repo.
