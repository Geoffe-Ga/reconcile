# ADR-0062: Stay a 501(c)(3) Path; Pick the Sponsor After the Pilot

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-later-phases`, decisions `entity-form`, `sponsor`
- **Refines:** [ADR-0020](0020-us-nonprofit-zero-knowledge.md), [ADR-0033](0033-legal-entity-staging.md)

## Decision

- **Reconcile's entity stays on the 501(c)(3) path** of ADR-0033: founder-owned pilot, then a fiscal sponsor, then its own 501(c)(3). A public benefit corporation was considered and rejected. A PBC can be sold, and a buyer could change what the app collects, which is the weaponization risk this project exists to avoid.
- **Later, when there's real revenue:** a 501(c)(3) owning an operating company (an LLC or PBC), as Signal and Mozilla do. In the founder's words, it's "overkill before there is real revenue."
- **Choosing the fiscal sponsor waits until after a successful pilot (ADR-0056), or until money is actually needed.** At that point, call all three shortlisted sponsors with the same questions, then choose:
  - **Hack Club HCB:** 7%; the public ledger can be turned off; it holds IP "on your behalf," so written transfer-out terms are needed.
  - **Social Good Fund, Model C:** 6.5% plus $29 a month; IP stays with us; payouts to groups need its approval.
  - **Aspiration:** a digital-rights focus with spin-out support; its fees aren't published.
- **The question list for every call:**
  - IP and transfer-out terms in writing
  - ledger and donor privacy
  - whether it allows payouts to groups
  - whether a non-OSI license is acceptable
  - fees

## Consequences

- No legal entity, sponsor, or money until then. The founder holds the domain and repo (ADR-0033 stage 1).
- Research notes dated 2026-11-08 are in the decision sheet. Re-check fees and terms when the calls happen.
