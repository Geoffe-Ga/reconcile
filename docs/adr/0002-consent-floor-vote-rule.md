# ADR-0002: Votes Pass on a Consent Floor

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-phase-0`, decision `vote-threshold`

## Context

Members score a proposed change from 0 (strongly opposed) to 4 (strongly supportive). The original slides said a change passes "if a minimum score is met" without defining the minimum. The rule shapes the culture. It decides whether a lukewarm majority can push changes through, and whether a determined minority can block them.

We considered three rules: average ≥ 2.5, a consent floor, and two-thirds scoring 3 or 4.

## Decision

**A change passes when both conditions hold among the members who voted:**

1. The average score is **at least 2.0**, and
2. **Fewer than 10%** of voters scored it **0**.

Mission statements are meant to represent the whole group. A consent floor keeps a quiet majority from overriding members who strongly object. That kind of override is the splintering Reconcile exists to prevent.

## Consequences

- Strong objections carry real weight. A small, committed group of 0s can stop a change that most people mildly like.
- Changes move more slowly than under a simple average. That's accepted for values and mission text.
- The rule takes two lines and an example to explain. The voting UI must show both numbers live, so the outcome is never a surprise.

## Open Questions

- **Quorum.** With low turnout, a handful of people could decide for a large group. The sheet proposed a quorum of opted-in voters, separate from the pass rule. Not yet decided.
- **Reasons for 0.** Requiring a short written reason with each 0 would make blocking deliberate and visible. Not yet decided.
- **Configurability.** Should groups later be able to tune the 2.0 and 10% values? Defer until ADR-0003's per-group evolution is real.
- **Holonic promotion.** Whether this rule applies unchanged at every level of promotion (ADR-0001) is open.
- **Competing versions.** How the rule picks a winner when several versions of one Atom pass is covered by ADR-0004.

## Update (2026-11-07)

Confirmed with the Phase 1 spec: quorum is at least 3 ballots and 30% of eligible voters; a score of 0 must carry a reason; when several competing versions pass, the winner is the highest average, then fewest zeros, then the earliest submitted. See `docs/spec/phase-1-spec.md` §4.

## Amendment (2026-11-08)

Both open questions are answered. Quorum is at least 3 ballots and 30% of eligible voters, and a missed quorum lapses ([ADR-0047](0047-ballot-cap-quorum-reproposals.md)). Every 0 requires a reason (spec §4, confirmed 2026-11-07).
