# ADR-0016: Stewards Suspend; Only a Vote Removes

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-trust-safety`, decision `removal`

## Decision

- **Stewards** are an elected capability (ADR-0003), not a new level. They can **suspend** a member at once: no posting, proposing, or voting.
- **A suspension lapses after 7 days** unless a removal Proposal passes the consent floor (ADR-0002) in that time.
- A suspended member's votes already cast on open Proposals still count. Every suspension is visible to the whole group.
- **Removal rotates the group key**, so the removed member sees nothing new. The UI says plainly that they keep what they already had.

## Consequences

- The same steward capability applies the covenant at Reconcile-the-group's level (ADR-0013).
- Steward elections are ordinary Proposals. Removal rules can be entrenched (ADR-0015).

## Amendment (2026-11-08)

A suspension continues while a removal Proposal against the member is open, and ends at once if it fails ([ADR-0059](0059-suspension-during-removal.md)).
