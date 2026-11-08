# ADR-0010: Open Ballots Within the Group, Backed by a Right to Exit

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-system-design`, decision `ballot-privacy`

## Context

The threat model lists voting records as high-risk data, but without a trusted server members have to be able to check a tally. Open ballots are easy to verify and easy to coerce. Secret ballots resist coercion but need heavy cryptography.

## Decision

**Each vote is a signed event that every member of the group can see.** Anyone can recount. Ballots never leave the group: Members and other groups see only the result. The ballot format is versioned (ADR-0006) so anonymous or secret ballots can replace it, for example before coalition-wide or holonic votes.

**From the user's notes:** open ballots also guard against a small hidden minority blocking change. **Coercion is offset by a right to exit.** Members can always leave, groups can remove members, and a minority can splinter (fork the group with its document history). Reconciling must always be the easiest path and splintering the hardest, but none of the three can be impossible.

## Consequences

- **The protocol needs three exit events:** leave, remove, and fork. Fork copies the canonical Document and history into a new group. Removal rules are in the security and moderation sheet.
- **A seized device shows how every member of its groups voted.** Device protection is in the security and moderation sheet.
- **Friction is deliberate:** the UI puts "pitch a change" and "reconcile" ahead of "fork", and a fork shows what would be lost.
