# ADR-0067: Genesis Templates: Circle, Fellowship, Chapter

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-four-lenses`, decision `structure` (chose `templates`)
- **Refines:** [ADR-0049](0049-stewards-and-removal.md), [ADR-0051](0051-dissolution-and-rule-classes.md); spec §4 default founding rules

## Context

Bateson, adrienne maree brown, and Eisenstein noted that a four-person family gets the same steward elections, quorum, and week-long windows as a 200-person chapter. One rule set fits neither well.

## Decision

The founder picks a **template** when creating a group. A template is only a preset of founding rules. Every template runs the same protocol and keeps the same privacy floors.

**Fixed in every template (never part of a template):** per-group identities, invite-and-vouch admission, encryption, ballot expiry within 7–90 days, removal at the entrenched bar, and the consent-floor pass rules.

| | **Circle** | **Fellowship** | **Chapter** |
|---|---|---|---|
| For | families and friends, under 10 voting members | most groups: recovery fellowships, creator communities, workplaces | movement chapters that will join coalitions |
| Vote window (ordinary / entrenched) | 3 / 7 days | 7 / 14 days | 7 / 14 days |
| Stewards | 1 seat, no term | as ADR-0049 | as ADR-0049 |
| Invite default uses | 5 | 10 | 10 |
| Phase | 1 | 1 (today's defaults) | 2, with coalitions |

*Assumed numbers, stated rather than asked:* the Circle values above, and the size threshold below.

- **A Circle grows into a Fellowship automatically** when it reaches 10 voting members. Any rule the group already changed by Proposal keeps its value. Rules still at the Circle default switch to the Fellowship default, which applies to Proposals opened after the change, and a steward election opens.
- The `genesis` event records the template. The switch is a rule change every device derives from the log, so no one has to author it.

## Consequences

- Spec §4's default founding rules become the Fellowship column. The Create Organization screen (spec §7) asks which template, with plain descriptions.
- Chapter is reserved in Phase 1 and rejected until Phase 2.

## Amendment (2026-11-08, decomposition details)

A Circle keeps 1 steward seat at any size until the switch. Group state tracks which rules a Proposal has set, so the switch can leave those alone ([ADR-0072](0072-protocol-details-for-decomposition.md)).
