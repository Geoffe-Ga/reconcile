# ADR-0070: Patronage, Not Attention: No Per-Read Share, a Cost-of-Running Anchor

- **Status:** Accepted in direction; Phase 3, same gate as ADR-0034
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-four-lenses`, decision `money` (chose `no-per-read` and `cost-anchor`)
- **Amends:** [ADR-0027](0027-supporters-and-coalition-tip-share.md), [ADR-0063](0063-money-rules.md), [ADR-0025](0025-gift-economy.md)

## Context

Rushkoff's and Eisenstein's lenses found that paying coalitions per read, and pricing gifts against ad rates, made attention the unit of value, which ADR-0001 set out to design out.

## Decision

1. **No coalition share of tips by reads.** ADR-0027's coalition tip share and ADR-0063's 10% are withdrawn. Tips go to the group whose piece it is. Coalitions are funded the same way groups are: **supporters**, meaning patronage of a group or coalition, not of content.
2. **The gift anchor is what Reconcile costs to run, not what ads cost.**
   - The nonprofit publishes a signed monthly figure: what running Reconcile cost, and an estimated cost per active member, worked out from aggregate relay counts that hold no identities.
   - The device shows: "Running Reconcile costs about $X a month. A fair share for a group your size is about $Y." Y is computed on the device from the group's size.
   - It's still a comparison, never a price or a debt, and the `DESIGN.md` gift-prompt rules apply.
   - This replaces ADR-0063 item 5 (the M+R CPM anchor) and its yearly update task.

## Not changed

ADR-0063's payee rules, pay-what-you-want platform fee, and balance on dissolution (to the payee after a final call for Proposals) stand. "Pass balances on by vote" wasn't chosen.

## Consequences

- No attribution of reads is needed at all, which removes the hardest privacy constraint in ADR-0027 (attribution on the reader's device).
- Coalition tip-share attachments on promotion records (ADR-0037) are dropped.
- Publishing the monthly cost is a recurring operations task once money flows.
