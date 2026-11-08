# ADR-0004: Competing Versions of an Atom All Go to the Ballot

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-phase-0`, decision `conflict-resolution`

## Context

Co-Creators edit in working copies. When two working copies change the same Atom, the versions conflict. The original slides showed a side-by-side comparison where collaborators "choose which competing text is better," followed by a vote. They didn't say whether that choice was a moderation step before the vote or part of it.

We considered three approaches: put every version on the ballot, have approvers pick one version first, or let the first proposal win and make later ones rebase.

## Decision

**Every competing version goes on the ballot, shown side by side. Voters score each version.** Nobody filters which versions voters see.

A small approver group would become a gatekeeper and a natural point of capture, which contradicts the anti-capture principle. The ballot keeps the choice with the people who vote.

## Consequences

- Ballots can be longer and voters do more work.
- The voting UI must make side-by-side comparison easy, with a diff against the current text, on phone screens as well as desktop.
- Each version is scored under the consent floor (ADR-0002).

## Open Questions

- **Several versions pass.** If more than one version clears the consent floor, which one wins? Candidates: the highest average, the fewest 0s, or a runoff. Not yet decided.
- **No version passes.** The current text presumably stands. Confirm it.
- **Ballot size.** The sheet proposed capping a ballot at three versions, with any further version becoming a new proposal. Not yet decided.

## Amendment (2026-11-08)

Both open questions are answered. When several versions pass: highest average, then fewest zeros, then the earliest version (spec §4, confirmed 2026-11-07). Ballot size: at most 3 versions ([ADR-0047](0047-ballot-cap-quorum-reproposals.md)).
