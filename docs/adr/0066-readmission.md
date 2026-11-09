# ADR-0066: A Way Back After Removal

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-four-lenses`, decision `repair` (chose `readmit`)
- **Refines:** [ADR-0049](0049-stewards-and-removal.md), [ADR-0016](0016-suspend-then-vote.md)

## Context

adrienne maree brown's lens found that the tools were suspend, remove, and split, and no ADR mentioned coming back. The founder chose a way back. The lighter "pause for repair" flag wasn't chosen, so suspension and removal otherwise stand as decided.

## Decision

- **A removed person can be readmitted by an ordinary Proposal** with a new target kind, `readmit`, naming the removed membership. Any Co-Creator can propose it. The removed person can't, since they're no longer a member, so they ask someone who still is.
- It passes at the **ordinary bar**, not the entrenched bar that removal needs. Coming back should be easier than being pushed out.
- After it passes, the person **joins as a newcomer**: a fresh invite, a new per-group key (ADR-0009), and fresh vouches with the usual wait before voting (ADR-0014). Their new membership records the passed `readmit` Proposal, so the group sees "returned" rather than a stranger.
- The re-proposal limits (ADR-0047) apply to repeated `readmit` Proposals for the same person.
- **No harm narrative is recorded.** The log holds the Proposal's title and justification, like any other Proposal, and nothing else about why the person left or returned.

## Consequences

- Spec §4 gains the `readmit` target kind and an optional `readmit` Proposal id on `join`. Phase 1 builds it, because removal ships in Phase 1.
- A removed person rejoining without a `readmit` Proposal is just a new person with a new invite. Per-group identities mean the app can't stop that and doesn't try.

## Amendment (2026-11-08, decomposition details)

A passed `readmit` Proposal names the removed member's old key and is redeemed through a single-use invite carrying its id. Titles and justifications of `removal` and `readmit` Proposals expire with their ballots ([ADR-0072](0072-protocol-details-for-decomposition.md)).
