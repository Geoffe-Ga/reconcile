# ADR-0051: Dissolving a Group; Which Founding Rules Start Entrenched

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-governance-edges`, decisions `dissolution`, `genesis-classes`
- **Refines:** [ADR-0015](0015-anti-capture.md), [ADR-0040](0040-group-opt-ins-are-governed.md)

## Decision

**Dissolution**
- **Dissolving needs the entrenched bar** (a Proposal with target kind `rules`, then a `dissolve` event).
- **Each device keeps a read-only archive by default**, and relay mailboxes are deleted.
- **The vote can add "wipe everywhere".** Devices honor it, and the UI says plainly that no app can stop someone who already kept a copy.

**Rule classes at genesis**
- **Entrenched:** the pass rules, quorum, eligibility, removal rules, steward and suspension rules, dissolution, and the entrenchment rule itself.
- **Ordinary:** vote windows, vouches required, the wait before voting, the re-proposal cooldown and cap (ADR-0047), and ballot expiry, tunable **from 7 to 90 days, default 30** (ADR-0017).
- **Opt-ins** follow ADR-0040: widening exposure is entrenched, narrowing it is ordinary.

## Consequences

- `genesis` records each rule's class. Validation applies the class's bar to every `rules-change`.
- A dissolved group can't be revived. Members keep their read-only copies.

## Amendment (2026-11-08, decomposition details)

Dissolution now uses its own Proposal target kind, `dissolve`, at the entrenched bar, instead of a `rules` target. The Circle → Fellowship switch is the one rule change made without a Proposal; it changes only rules no Proposal ever set ([ADR-0072](0072-protocol-details-for-decomposition.md)).
