# ADR-0027: Group Supporters, Coalition Tip Share, and Monthly Cash-Out

- **Status:** Accepted in direction; the payment design is open (same gate as ADR-0025's peer tips)
- **Date:** 2026-11-07
- **Decided via:** the user's direct instruction, extending [ADR-0025](0025-gift-economy.md)

## Decision

1. **Supporters.** Anyone in a group or coalition, at any level (Member, Collaborator, or Co-Creator), can become a **supporter** with a monthly subscription to that group. Groups spend the funds on outreach, including the reach-cost gifts back to Reconcile in ADR-0025.
2. **Coalition tip share.** When a coalition votes to publish a piece into its own canon (holonic promotion, ADR-0001), part of each tip on that piece goes to the coalition, **but only for reads that coalition generated.**
3. **Cash-out.** Groups and coalitions can withdraw their balance **at most once a month**.

## Design Constraints (Binding)

These follow from ADR-0001, 0009, and 0017. The payment design ADR must satisfy them:

- **Attribution happens on the reader's device, never through view tracking.** The reading client already knows how the reader arrived: from coalition C's canon or a C Dispatch. When the reader tips, the client splits the tip there and shows the split before they confirm ("20% goes to Coalition C, which published this"). No server logs views or referrals.
- **The payment rail must not learn who supports which group.** A recurring card charge that names a group is a membership record held by a processor. The payment design must separate *who pays* from *where it goes*.
  - A strong candidate: **blind-signed credits**, as in GNU Taler or Chaumian e-cash. A person buys Reconcile credits by card, so the processor sees only "bought $10 of Reconcile credits". The credits move inside the encrypted group as unlinkable tokens. The group redeems them, so the payer stays anonymous while the payee is known, as tax and compliance require.
  - A subscription is then an automatic monthly purchase plus an automatic transfer inside the group.
- **Payees have to be identified; payers don't.** Cashing out fiat needs a verified payee:
  - Options are a treasurer elected by Proposal, a fiscal sponsor, or the group's own legal entity.
  - That payee's identity is linked to the group, so each group must choose it knowingly, and the UI must say so plainly.
  - Batching withdrawals monthly also blurs timing.
- **Splits are governed.** The default coalition share (proposed: 20%) and each group's spending of supporter funds are group rules, changed by Proposal (spec §4).
- **Nothing here is modal or guilt-driven.** The `DESIGN.md` gift-prompt rules apply.

## Open Questions

To settle in the payment design ADR, before any money code:

1. The payment rail: blind credits (Taler-style), a processor marketplace (Stripe Connect: simplest, but it sees the whole graph), or cryptocurrency.
2. Who a group's payee is: an elected treasurer, a fiscal sponsor, or a legal entity.
3. Legal: stored value, payouts, and fees on transfers between users likely make Reconcile, or its payment partner, a money transmitter. As a 501(c)(3), fee income may count as unrelated business income. **This needs counsel before building.**
4. Splits when several coalitions promote the same piece: a read is attributed to the coalition it actually came through, so this only matters for split *defaults*.
5. What happens to a group's balance on a fork (ADR-0015) or dissolution.

## Phase

Phase 3, alongside Dispatches and calls to action. Phase 1 builds none of this. The governance log (ADR-0006) should reserve event types for treasurer election and rule changes to splits so they don't need a protocol revision later.

## Amendment (2026-11-07)

Open question 1 (the rail) is resolved by [ADR-0034](0034-blind-credit-payment-rail.md). The payee is a group rule changed by Proposal ([ADR-0040](0040-group-opt-ins-are-governed.md)); the payee options themselves are still open.
