# ADR-0013: A Founding Covenant That Limits Reach, Not Existence

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-trust-safety`, decision `hate-groups`

## Context

A local-first tool can't stop a group from using it privately (ADR-0001). Reconcile does control **reach**: discovery, coalition invitations, Dispatches beyond a group's own followers, and holonic broadcast.

## Decision

- **Reconcile ships with a short founding covenant:** no calls for violence and no dehumanizing protected groups. It is the first Document of Reconcile-the-group, which its users amend through the normal Proposal → Vote loop, as an entrenched Atom (ADR-0015).
- **Breaking the covenant costs reach, not existence.** An offending group loses discovery, coalition invitations, and broadcast. Nobody can read or delete its private data.
- **The covenant is applied by stewards** that Reconcile-the-group elects (ADR-0016). They judge only content that was made public or reported to them. Their decisions are public, and a group that is denied reach can appeal by vote.

## Open Source or Not (resolved by ADR-0024: source-available)

**From the user's notes:** "I actually don't want this to be forkable. I want to consider pivoting away from open source." This isn't decided. The README currently says MIT, and there's no LICENSE file yet, so **nothing has been published under a license**. Points to weigh in a follow-up decision:

- A closed client doesn't stop a hostile fork of the *protocol*. Anyone can write a client against the relay or run their own relay. What limits reach is the covenant at the reach points, whatever the license.
- Zero-knowledge claims (ADR-0019, 0020) are much easier to trust when the client can be audited. Source-available licenses (for example BSL or a custom non-commercial license) or an external audit are middle paths.
- A trademark on "Reconcile" can stop a fork from using the name, independently of the code license.

Resolved 2026-11-07 by [ADR-0024](0024-source-available-license.md).

## Amendment (2026-11-07)

Reconcile-the-group starts from a one-line eternal core plus a founder steward seat that converts to elections ([ADR-0035](0035-reconcile-group-minimal-eternal-core.md)).
