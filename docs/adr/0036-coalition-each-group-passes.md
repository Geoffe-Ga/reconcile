# ADR-0036: Coalition Decisions Pass Group by Group

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-remaining`, decision `coalition-voting`
- **Builds on:** [ADR-0009](0009-per-group-identities.md), [ADR-0010](0010-open-ballots-with-exit.md)

## Decision

- Every member group votes on a coalition motion **inside the group, under its own consent floor** (ADR-0002).
- **Only a signed pass or fail result crosses group lines.** No individual ballot, voter identity, or score leaves a group.
- **Threshold (assumption, from the sheet's lean):** coalitions of up to 4 groups need every group to pass. Coalitions of 5 or more need two-thirds of their groups, so one group can't block forever. The threshold is a coalition rule, changed by a coalition motion.
- Forming a coalition (the reconcile vote) always needs every founding group to pass.

## Why

It's the only option that keeps every ballot in its group and protects small groups from being outvoted by large ones. Protecting small groups is the reason to reconcile at all.

## Consequences

- This settles "secret ballots for coalition-wide votes": there are no coalition-wide individual ballots.
- A group that is repeatedly outvoted under the two-thirds rule can leave the coalition. Split petitions follow ADR-0015.
- New log event for Phase 2: a signed `group-result`, which a coalition's log accepts from each member group.
