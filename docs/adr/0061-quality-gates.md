# ADR-0061: The Merge Gates; Mutation Testing Before a Release

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-dev-process`, decision `ci-scope` (the founder's own approach)

## Decision

From the founder: "Mutation only recommended before release. The gates are: TDD, check-all.sh on relevant paths, pre-commit on changed files, CI on changed files (full matrix necessary only on backend), Claude review in the repo, all must pass (with a COMMENTS verdict counting as passed but requiring a follow-up filed, and LGTM preferred)."

**Merge gates**
1. **TDD:** a failing test first.
2. **`./scripts/check-all.sh`** for the areas the change touches.
3. **Pre-commit on the changed files:** `./scripts/precommit-changed.sh`.
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

## Amendment (2026-11-12): `main` Runs the Full CI Nightly, Not on Each Merge

**Chosen by the owner on 2026-11-12, decision 1 in [#367](https://github.com/Geoffe-Ga/reconcile/pull/367).**

- **What changed.** `ci.yml` has no `push` trigger. It runs on each pull request to `main`, once a day (14:17 UTC, a quiet hour for merges), and on manual dispatch. A nightly or manual run has no base to diff against, so it checks every area and pre-commits every file. The mutation job stays manual only. Gate 4 is unchanged: each PR's CI must still be green.
- **Why.** CI ran 33 times on `main` in about 13.5 hours, once per merge, for about 540 runner-minutes; 11 of those runs were cancelled midway and still billed. The PR's own CI had usually tested the exact tree that landed, because `main` was an ancestor of the PR head. The account hit its Actions spending limit that day ([#221](https://github.com/Geoffe-Ga/reconcile/issues/221)).
- **The risk: skew.** A PR's CI tests it merged with `main` as `main` stood at the PR's last push. Nothing yet requires an up-to-date branch, so after another merge the tree that lands may be one no CI run checked. Two PRs that pass apart and break together then reach `main` unseen, and the next PR's CI can fail on the break and take the blame.
- **The mitigation.** Before each merge, the PR is merged with current `main` locally, and the types (`tsc`), the architecture check and the related tests run on that tree. The nightly full run is the backstop: it finds anything that slips through within a day. A ruleset that requires up-to-date branches ([#358](https://github.com/Geoffe-Ga/reconcile/issues/358)) would close the gap; this change doesn't wait for it.
