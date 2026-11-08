# ADR-0071: Anyone May Run a Relay; Reach Stops at Coalitions

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-four-lenses`, decision `steering` (chose `self-host-grant` and `no-broadcast`)
- **Amends:** [ADR-0024](0024-source-available-license.md), [ADR-0037](0037-holonic-promotion.md), [ADR-0001](0001-local-first-trust-model.md)

## Context

Rushkoff's lens found that a tool for self-governance was founder-held and licensed against running it, while ADR-0007 promises a relay choice. It also found that a Reconcile-wide broadcast would make Reconcile-the-group the most valuable thing to capture (ADR-0001, tension 3).

## Decision

1. **Self-hosting grant.** When the license is written (ADR-0024: at publication, confirmed by a lawyer), it will include an explicit grant to **run unmodified relays and clients**, for any group, without asking. Modifying and redistributing still need permission. This removes the contradiction with ADR-0007's relay choice.
2. **Community roadmap.** Once Reconcile-the-group exists (Phase 2), it ratifies the license and the roadmap's priorities as entrenched Atoms. Until then the founder holds them.
3. **Reach stops at coalitions.** The author's promotion ceiling (ADR-0037) runs from "this group only" up to "as far as the coalitions go". There is **no Reconcile-wide broadcast**: ADR-0037 item 4 is withdrawn, and so is ADR-0001's broadcast by the outermost group. Reconcile-the-group still edits its own mission and documents by the normal loop.

## Not chosen

A named human's sign-off on protocol and cryptography PRs wasn't chosen. ADR-0060's green merges stand.

## Consequences

- ADR-0001's tensions 2 (a broadcast path) and 3 (the outermost group as a capture target) shrink: no global delivery layer is needed, and controlling Reconcile-the-group no longer reaches every user.
- The `ceiling` field's top value is `coalitions`, not `everyone`.
- The license itself stays deferred until publication (`docs/spec/decision-roadmap.md`).
