# ADR-0048: Proposals That Draw Early Enthusiasm Rise in the Feed

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-governance-edges`, from the founder's note on `missed-quorum`: "within big groups, a swarm algorithm can help determine what gets viewed. Things that get enthusiastic votes quickly (or trend that way) are surfaced to collaborators higher up in the feed."

## Decision

- **Each device ranks its group's open Proposals locally**, from the open ballots it already holds (ADR-0010). The default sort combines how fast ballots arrive with how enthusiastic they are: average score and few zeros, weighted toward recent ballots.
- **No server ranks anything.** The relay sees only ciphertext (ADR-0001, 0019), so ranking can only happen on devices, and every device computes the same order from the same log.
- **Ranking never hides a Proposal.** Everything stays reachable. "Newest" and "closing soon" sorts are one tap away, and a Proposal near its window's end and short of quorum is pinned with a quiet "needs votes" label, so ranking can't starve a vote into lapsing.

## Consequences

- Phase 1 ships the sort with simple weights. Tune them after the pilot. Small groups barely notice it.
- Bandwagon risk: early enthusiasm attracts more attention. Ballots are already open (ADR-0010), so this adds ordering, not new information. The "needs votes" pin offsets it.
- The ranking function lives in the client engine (`src/engine`), framework-free and unit-tested.

## Amendment (2026-11-08, four-lenses review)

The enthusiasm sort is now the **Rising** tab. The default tab is **Quiet**, which puts the least-heard Proposals first, and it replaces the "needs votes" pin ([ADR-0064](0064-feed-tabs-quiet-and-rising.md)).
