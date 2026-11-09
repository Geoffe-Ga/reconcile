# ADR-0054: Notifications Arrive as a Daily Digest; Recovery Attempts Are Immediate

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-onboarding-ux`, decision `notifications` (chose `digest`)
- **Refines:** [ADR-0012](0012-content-free-push.md)

## Decision

- **One daily digest per person.** It covers new Proposals, results, new members, voting rights arriving, and **votes they haven't cast that close within the next 24 hours**.
- **Only a recovery attempt on their own identity notifies immediately.** It can't be turned off (ADR-0043).
- Push stays content-free: the push wakes the app, which builds the digest locally. The notification text is generic ("Your Reconcile digest is ready").
- People choose the digest time in Settings.

## Consequences

- With quorum misses lapsing immediately (ADR-0047), listing closing votes in the digest is the main protection against lapses. The "needs votes" pin (ADR-0048) is the other.
- A suspension or a removal Proposal against someone appears in their next digest. The 7-day suspension limit and the 14-day removal window leave time to respond.

## Amendment (2026-11-08, decomposition details)

Lock-screen text is generic: no group names, counts, or titles ([ADR-0072](0072-protocol-details-for-decomposition.md)).
