# ADR-0025: A Gift Economy

- **Status:** Accepted in direction; the peer-tip design is open
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-product-stack`, decision `business-model` (the user's own approach)

## Decision

Reconcile is free to use and runs on **reciprocity**. There are two kinds of gift, and every gift prompt is contextual, clearly optional, and never self-deprecating:

1. **Gifts to the platform at the moment of reach.** When a group or coalition publishes a call to action or Dispatch, its publishers see what that reach would normally cost and are invited to gift part of it back:

   > "Reconcile is free to use and depends on reciprocity to keep running. Reaching 2,400 people this way usually costs about $X. Would you like to gift back to the platform?"

2. **Tips to authors (peer gifts).** Reading someone's post offers a tip jar. The author receives the gift, and Reconcile keeps a transaction fee.

The prompt's design is in `DESIGN.md` under "Gift prompt": inline, never modal, and never repeated within a session.

## Tensions to Resolve Before Building Peer Tips

Platform gifts can ship as ordinary donations to the nonprofit, which are tax-deductible and need nothing new from the protocol. **Peer tips need a follow-up ADR**, because they collide with the threat model and with the law:

1. **Payments are identity.** A card payment links the tipper's real identity to the author's, and through context to a group and a post. That's exactly the association data ADR-0001 and ADR-0009 exist to prevent. The payment processor must never learn which post, group, or per-group identity a tip is for. Possible approaches: prepaid credits bought without context and transferred inside encrypted groups, or redeemable gift codes.
2. **Payouts require KYC.** Paying authors through a processor such as Stripe Connect means verifying each author's legal identity, which would create a central list of authors' real identities, held by us.
3. **Money transmission.** Taking a fee on transfers between users can make the nonprofit a money transmitter or payment facilitator. This needs legal advice. Tips to individuals also aren't charitable activity, so fee income may be unrelated business income for a 501(c)(3).

Group supporter subscriptions, the coalition tip share, and cash-out extend this ([ADR-0027](0027-supporters-and-coalition-tip-share.md)) under the same gate.

Until that ADR exists, **build platform gifts only.** They belong to Phase 3, with Dispatches and calls to action.

## The Reach-Cost Anchor

Suggested amounts need a defensible "normal cost to reach n people". Rough US reference points for 2024–26 must be sourced before shipping:
- paid social or display ads: about $5–$30 per thousand impressions
- peer-to-peer texting: a few cents per message
- direct mail: about $0.50–$1 per piece
- door-to-door canvassing: commonly cited around $30 or more per additional vote, from field-experiment research

The prompt should anchor on a conservative digital-reach figure per recipient, published with its source.

## Amendment (2026-11-07)

The rail is decided in [ADR-0034](0034-blind-credit-payment-rail.md): blind-signed credits for peer money, an ordinary processor for platform gifts, never a marketplace processor.
