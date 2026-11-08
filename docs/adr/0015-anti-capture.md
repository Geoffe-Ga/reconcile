# ADR-0015: Anti-Capture: Eligibility Snapshots, Entrenched and Eternal Atoms, Fork as a Last Resort

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-trust-safety`, decision `capture`

## Context

The usual coup in a voting system is entryism: flood a group, then vote to rewrite its mission or remove its founders.

## Decision

1. **Eligibility snapshot.** Only people who were voting members when a Proposal opened may vote on it.
2. **Entrenched Atoms.** A group can mark core Atoms as needing a higher bar to change. Default: average ≥ 3.0, under 5% zeros, and a window twice as long. Entrenchment is itself entrenched.
3. **Eternal Atoms (eternity clauses).** A group can mark an Atom as unamendable. The only way to escape it is to leave or fork. Marking an Atom eternal needs the entrenched bar, and the UI warns that this is permanent. Reconcile-the-group's covenant core (ADR-0013) is eternal.
4. **Fork with history, but only in extreme circumstances.** **From the user's notes:** splitting must not appear on every vote that doesn't go someone's way. A fork is available only through a **fork petition**, opened from group settings and never from a vote result. It needs signatures from at least 20% of voting members (a default each group can tune) **and** a trigger:
   - an entrenched Atom changed,
   - a removal or suspension affecting at least 10% of members within 30 days, or
   - a stewards' decision that the petitioners appeal and lose.

The growth brake was not chosen.

## Consequences

- This refines ADR-0010: exit stays possible, but forking is deliberately rare and hard to reach.
- In a fork, Members choose whom to follow. That flow belongs to Phase 3.
- The trigger list and the 20% default are assumptions. Revisit them once real groups use the feature.
