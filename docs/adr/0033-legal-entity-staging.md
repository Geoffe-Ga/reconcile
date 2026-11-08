# ADR-0033: The Legal Entity Arrives in Three Stages

- **Status:** Accepted; the sponsor itself is still to be chosen
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-remaining`, decision `legal-entity` (chose `fiscal-sponsor`, with the founder's note: "one step at a time")
- **Refines:** [ADR-0020](0020-us-nonprofit-zero-knowledge.md)

## Decision

| Stage | When | Who holds the domain, trademark, repo, and contracts | Money |
|-------|------|------------------------------------------------------|-------|
| **1. Founder-owned pilot** | Now, through the first pilot groups | The founder, personally | None. No gifts, no tips, no supporters. |
| **2. Fiscal sponsor** | Once the pilot proves the loop and growth begins | A 501(c)(3) fiscal sponsor, on Reconcile's behalf | Platform gifts (ADR-0025) through the sponsor |
| **3. Reconcile's own nonprofit** | After the concept proves itself and stabilizes | Reconcile's own 501(c)(3) | Everything in ADR-0025, ADR-0027, ADR-0034 |

ADR-0020's commitments (hold nothing readable, no client scanning) bind at every stage, including the pilot.

## Choosing the Sponsor: An Open Decision of Its Own

The founder flagged this as an important choice. It needs its own decision sheet before Stage 2. Criteria:

- **License fit.** It must accept a source-available project. That rules out sponsors that require an OSI license, such as Software Freedom Conservancy and Open Source Collective. Open Collective Foundation closed in 2024.
- **Sponsorship model.** Under *comprehensive* (Model A) sponsorship, the sponsor legally owns the project's assets, possibly including the trademark, domain, and code. Under *pre-approved grant* (Model C), the project keeps them but usually needs its own entity. The agreement must say how assets transfer to Reconcile's own nonprofit at Stage 3.
- **Privacy.** Some sponsors publish every transaction by default. Donor and payee data must not become a list of who supports Reconcile.
- **Payment model.** It must be willing to back a blind-credit rail (ADR-0034) and cash-outs to groups (ADR-0027) later, or at least not forbid them.
- **Mission fit and fees.** Typical fees are 5–10% of income.

Candidates to vet (not endorsements): Hack Club HCB, Social Good Fund, Code for Science & Society, Community Initiatives, Players Philanthropy Fund, Fractured Atlas.

## Consequences

- Stage 1 adds no payment code. Anything money-related stays Phase 3.
- During Stage 1 the founder holds the domain (`reconcile.earth`, ADR-0026) and trademark filing personally. Move them under the sponsor's agreement at Stage 2.
- Stage 3's trigger is a judgment call. Likely signals: sponsor fees exceed the cost of running our own entity, or a payment partner requires contracting with Reconcile directly.
