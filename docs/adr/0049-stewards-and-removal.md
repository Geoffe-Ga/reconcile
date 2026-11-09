# ADR-0049: Two Staggered Stewards; Removal at the Entrenched Bar Without the Target Voting

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it; [ADR-0074](0074-mvp-scope-revised.md) restores part of it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-governance-edges`, decisions `stewards`, `removal`
- **Refines:** [ADR-0016](0016-suspend-then-vote.md)

## Decision

**Stewards**
- **Two seats with staggered 6-month terms.** Groups under 6 voting members have one seat.
- **The founder holds a seat until the first election.** The election opens when the group reaches 3 voting members, which is also when the bootstrap rule switches off.
- **Recall by an ordinary Proposal, at any time.** Elections are Proposals with target kind `steward`.

**Removal**
- **Any voting member may propose a removal.** It needs the **entrenched bar**: average ≥ 3.0, under 5% zeros, and a 14-day window.
- **The person being removed isn't eligible to vote on it.** Otherwise their own 0 alone could block it in a group of 9 or fewer.
- **They may post one response, shown on the ballot** (new event: `removal-response`).
- After a passed removal: `remove`, then `key-rotate`. A 7-day steward suspension covers urgent cases while the vote runs.

## Consequences

- Test vectors: the target's ballot is rejected, the response is accepted only from the target, and a removal that passes only at the ordinary bar fails.
- Term expiry opens a `steward` Proposal automatically, shown as a reminder.

## Amendment (2026-11-08, four-lenses review)

A removed person can be readmitted by an ordinary `readmit` Proposal, then joins as a newcomer with fresh vouches ([ADR-0066](0066-readmission.md)). Small groups can use the Circle template's single steward seat ([ADR-0067](0067-genesis-templates.md)).

## Amendment (2026-11-08, decomposition details)

A `removal-response` is at most 1,000 code points and expires with the removal vote's ballots, as do the removal Proposal's title and justification. A Circle keeps 1 steward seat at any size until it becomes a Fellowship ([ADR-0072](0072-protocol-details-for-decomposition.md)).
