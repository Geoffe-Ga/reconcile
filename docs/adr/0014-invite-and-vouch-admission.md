# ADR-0014: Admission by Invitation and Vouching

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-trust-safety`, decision `sybil`

## Context

Per-group identities (ADR-0009) make fake accounts free to create, and captchas no longer stop AI agents. Proof-of-personhood services would tie identities to biometrics or IDs.

## Decision

- **People join by invitation.** Voting rights arrive after vouches from existing Collaborators and a waiting period. Defaults: 1 invite, 2 vouches, and a 14-day wait. Each group sets its own rules through capabilities (ADR-0003).
- **Vouches are signed log events** that the whole group can see. If an account is removed as fake, the members who vouched for it lose vouching rights for a set period.
- **The UI encourages a "vibe check":** a video call or an in-person meeting before vouching. That happens in the group's linked chat (ADR-0011). Reconcile is not a video platform.

## Consequences

- This settles the open question of a voting wait: the default is 14 days, and each group can tune it.
- Growth is slower and follows real relationships, which fits ADR-0001.
- Newcomers with no contact inside a group need a public way in. That's a Phase 2 discovery question.
