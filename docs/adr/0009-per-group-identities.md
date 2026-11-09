# ADR-0009: Separate Identity Per Group, Linked Only by Choice

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-system-design`, decision `linkability`

## Context

With one global identity, anyone in two of a member's groups can link them, which builds the association map Reconcile must not create. With a separate identity per group, coalition-mate discovery (ADR-0001) gets harder.

## Decision

**Each membership uses its own key and display name by default,** derived from the root identity (ADR-0008) on the member's device. Only that device knows they belong to the same person. **A member can choose to reveal a link** to a specific group or coalition. Revealing is explicit, scoped, and recorded on the member's device.

## Consequences

- **Coalition-mate discovery must work without linkage.** A member can recommend a group they're in, but nobody can compute "which groups my mates are in". Discovery becomes an act of sharing, not a query. ADR-0001's first tension is resolved in that direction.
- **Writing style and timing can still link identities.** The UI should say so plainly, and nothing should promise perfect unlinkability.
- **The UI must explain the consequence of each link** before the member reveals it, and offer no bulk "link everywhere" button.
- Per-group identities make Sybil attacks cheaper. Admission rules are in the security and moderation sheet.
