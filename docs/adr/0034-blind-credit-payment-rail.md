# ADR-0034: Money Moves as Blind-Signed Credits

- **Status:** Accepted in direction; gated on counsel and a licensed partner
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-remaining`, decision `payment-rail`
- **Resolves:** open question 1 in [ADR-0027](0027-supporters-and-coalition-tip-share.md), and the peer-tip rail in [ADR-0025](0025-gift-economy.md)

## Decision

1. **Peer money (tips, supporters, coalition shares) moves as blind-signed credits**, on the GNU Taler or Chaumian e-cash model. A person buys Reconcile credits by card, so the processor sees only "bought $10 of Reconcile credits". The credits move inside the encrypted group as unlinkable tokens. A group's verified payee redeems them. The payer stays anonymous; the payee is known.
2. **Gifts to the platform come first, through an ordinary donation processor** (Phase 3), via the fiscal sponsor (ADR-0033). A gift to Reconcile itself reveals only that someone supports Reconcile.
3. **No fallback to a marketplace processor.** If counsel or a licensed exchange partner doesn't materialize, peer flows wait. They never fall back to Stripe Connect or anything else that sees who pays which group.

## Why

It's the only option that meets ADR-0027's binding rule: the payment rail must never learn who supports which group.

## Consequences

- Before any peer-money code: legal counsel on money transmission, plus a licensed partner to run the exchange (the mint). GNU Taler exchanges are operated by licensed entities.
- A subscription becomes a monthly credit purchase plus an automatic transfer inside the group.
- Still open (ADR-0027): who a group's payee is, splits when several coalitions promote one piece, and a balance's fate on split or dissolution.
