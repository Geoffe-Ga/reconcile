# ADR-0038: Discovery Is Optional; Groups Can Open a Front Door

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-remaining`, decision `discovery` (chose `front-doors`, with the founder's notes)
- **Builds on:** [ADR-0009](0009-per-group-identities.md), [ADR-0014](0014-invite-and-vouch-admission.md), [ADR-0013](0013-covenant-on-reach.md); governed by [ADR-0040](0040-group-opt-ins-are-governed.md)

## Context

Reconcile isn't only for political organizing ([use cases](../use-cases.md)). Families, fan and creator communities, recovery fellowships, workplaces, and movements each want different things from discoverability, for different reasons.

## Decision

- **Discoverability is optional and off by default.** Sharing an invite card stays the default way in.
- **A group can open a front door:** a public page with the group's name, a mission excerpt, and an application form. Applicants are still admitted by invite, vouches, and the wait (ADR-0014). Their application reaches the group encrypted to the group's front-door key; the relay sees a sealed blob (ADR-0019).
- **A front door never lists people.** No member names or roster. A member count stays hidden unless the group opts to show it.
- **Being listed in a public index of front doors** is a separate, further opt-in. The covenant governs it (ADR-0013).
- **Opening, changing, or closing a front door is a group decision**, made by Proposal (ADR-0040).
- No anonymous "your coalition mates are in…" hints. They leak under real attacks.

## Consequences

- Phase 2: the front-door page, the application flow, and the optional index.
- The threat model applies per group. A recovery fellowship or a vulnerable movement chapter should never be pushed toward opening a door. The UI says plainly what a front door exposes.
