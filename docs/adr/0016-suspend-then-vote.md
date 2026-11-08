# ADR-0016: Stewards Suspend; Only a Vote Removes

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-trust-safety`, decision `removal`

## Decision

- **Stewards** are an elected capability (ADR-0003), not a new level. They can **suspend** a member at once: no posting, pitching, or voting.
- **A suspension lapses after 7 days** unless a removal Pitch passes the consent floor (ADR-0002) in that time.
- A suspended member's votes already cast on open Pitches still count. Every suspension is visible to the whole group.
- **Removal rotates the group key**, so the removed member sees nothing new. The UI says plainly that they keep what they already had.

## Consequences

- The same steward capability applies the covenant at Reconcile-the-group's level (ADR-0013).
- Steward elections are ordinary Pitches. Removal rules can be entrenched (ADR-0015).
