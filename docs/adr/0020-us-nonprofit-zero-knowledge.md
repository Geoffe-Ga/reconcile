# ADR-0020: A US Nonprofit That Holds Nothing Readable

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-trust-safety`, decision `legal`

## Decision

- Reconcile is run by a **US nonprofit** (501(c)(3) or similar) that operates the default relay and publishes the app.
- It **holds no readable user data**, publishes every legal demand it receives together with its reply, and challenges overbroad demands.
- **No client-side scanning.** Abuse inside a group is reported by members to that group's stewards (ADR-0016). Abuse that reaches across groups is reported to Reconcile-the-group's stewards (ADR-0013).

## Consequences

- National-security letters with gag orders remain a risk. The mitigations are independent relays, sealed sender (ADR-0019), and the transparency report.
- Forming the nonprofit costs money and needs legal help. That's the user's call on timing; it isn't needed before Phase 1 ships to test groups.

## Amendment (2026-11-07)

The entity arrives in stages: founder-owned pilot, then a fiscal sponsor, then Reconcile's own 501(c)(3) ([ADR-0033](0033-legal-entity-staging.md)).
