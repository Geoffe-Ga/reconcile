# ADR-0063: Money Rules: Entrenched Treasurers, 10% Coalition Share, Pay What You Want, Reach at Benchmark CPM

- **Status:** Accepted in direction; Phase 3, gated on counsel and a licensed partner (ADR-0034)
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-later-phases`, decisions `payee`, `coalition-share`, `platform-fee`, `balance-fate`, `reach-anchor`
- **Refines:** [ADR-0025](0025-gift-economy.md), [ADR-0027](0027-supporters-and-coalition-tip-share.md), [ADR-0034](0034-blind-credit-payment-rail.md)

## Decision

1. **Payee:** a group elects a **treasurer** (a verified individual) or names **its own legal entity**. Reconcile's sponsor never holds group money.
   - **Choosing or changing the payee needs the entrenched bar**, per the founder's note: "Changing a treasurer should be difficult."
   - *Assumption, stated rather than asked:* naming the *first* payee is also entrenched, because it ties a person's identity to the group. That widens exposure, which ADR-0040 already entrenches.
2. **Coalition share: 10%** of a tip goes to the coalition that brought the reader, attributed on the reader's device. It's a group rule, changeable by Proposal.
3. **Reconcile's fee on peer money: pay what you want.**
   - No fixed cut. The tip screen offers an optional extra for Reconcile at a suggested amount, which can be lowered to $0.
   - Payment costs pass through at cost.
   - The `DESIGN.md` gift-prompt rules apply: no guilt, no modal.
4. **A group's balance when it splits or dissolves goes to the group's payee to distribute as they see fit.**
   - A final call for Proposals on how to distribute it goes out first, and a passed Proposal binds the payee's instructions in the app.
   - With no Proposal, the default is the payee, "the same person it always would" (the founder's note). Most such groups will be dead chats.
   - On a split, the original group's payee holds it.
5. **Reach anchor: the current M+R Benchmarks nonprofit social CPM, $16 per 1,000 people in the 2026 edition.**
   - **Update it every year** when the new M+R study is published, to stay precise.
   - It's shown as "Reaching N people with ads would cost about $X," with the source and year cited.
   - It's framed as a comparison, never a price or a debt.

## Consequences

- **Capture incentive:** if dissolving pays the payee, then capturing a group and dissolving it could pay off. The guards:
  - dissolution needs the entrenched bar (ADR-0051);
  - changing the payee needs the entrenched bar;
  - balances are visible to the group.
- Per-group payees mean no central list of funded groups exists.
- **Upkeep:** a yearly task updates the CPM figure from the M+R release.
