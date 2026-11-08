# ADR-0040: Every Group-Level Opt-In Is Decided by Proposal

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** the founder's note on `/decide` sheet `2026-11-07-reconcile-remaining`, decision `integrations`

## Decision

- **Every group-level opt-in is a group rule, changed by a `rules` Proposal** (spec §4). That includes discoverability (ADR-0038), bot reach and sight (ADR-0039), coalition tip-share defaults, the group's payee (ADR-0027), and ballot expiry tuning (ADR-0017). No admin toggle exists.
- **Assumption (stated, not asked): widening and narrowing are asymmetric.**
  - Widening exposure (opening a front door, a deeper bot step) is an **entrenched** rules change, with a 14-day window (ADR-0015).
  - Narrowing exposure is an **ordinary** change. A steward can also narrow it immediately, as a 7-day suspension that then goes to a vote (ADR-0016).
  - Reason: exposure is hard to take back, and retreating should always be easy.

## Consequences

- No new target kind. Opt-ins live in the group's rules and use `target.kind: 'rules'`.
- The client's group-settings screen shows current values and offers "Propose a change". It never offers a direct toggle.
