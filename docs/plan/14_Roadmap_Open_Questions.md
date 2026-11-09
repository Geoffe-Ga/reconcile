# Roadmap and Open Questions (What’s defined vs TBD)

This doc separates:
- what has been explicitly stated/diagrammed,
- what is strongly implied,
- and what is clearly open.

## What feels defined (from source material)

- Core entities: Collaborators, Co-Creators, Organizations, Coalitions, Documents, Atoms
- Core loop: View → Proposal → Discuss → Vote → Update
- Coalition loop: View → Proposal → Discuss → Vote → Reconcile
- Onboarding: sign-in, personal page, find groups, reconcile with group
- Participation gradient: involvement levels
- Notification types: new docs, updates, pushes, votes
- Working-copy editing with autosave, shareable URL, conflicts, side-by-side comparison
- Debate bridge via messenger app, with “argument concluded” auto message

## Clearly open / TBD items explicitly mentioned

- “TODO: Better word for ‘Push’”
- “Messenger app (to be decided later)”

## Open questions created by the devil’s advocate critique

- Centralized vs local-first trust model (conceptual)
- Data minimization vs discoverability tradeoffs
- How to prevent the platform from becoming a “database of ideologies and associations”
- Safety and anti-abuse defaults
- Whether “ideological association” is a product feature or an emergent risk

## Open questions implied by the slides

- What are the exact involvement levels?
  - What permissions do they map to?
  - Who can vote, propose, approve, or just follow?
- How are voting thresholds defined?
  - Is 0–4 scoring used everywhere or only for values statements?
  - What counts as “minimum score met”?
- How do conflicts resolve in practice?
  - Is the “choose better text” step a pre-vote moderation step?
  - Or is it part of the vote itself?

## A reasonable “phase” roadmap (conceptual, not architecture)

Phase 0: Clarify definitions and ethics
- finalize entity definitions and boundaries
- decide on privacy and safety principles
- tighten terminology (“atom,” “push,” etc.)

Phase 1: Single-organization MVP
- onboarding
- create personal page
- create/join organization
- create document
- propose edits on atoms
- vote + update
- notifications

Phase 2: Coalition MVP
- discover orgs
- propose reconciliation
- dual voting
- create coalition entity
- coalition mission statement editing loop

Phase 3: Outer-loop activation
- robust co-creator experience
- scheduled/recurring pushes
- action calls and “what now?” flows

Again: this is not a commitment—just a way to organize what already exists into a buildable sequence.

## Decided (2026-11-07)

Settled through the `/decide` sheet "Reconcile Phase 0 Calls" and recorded in `docs/adr/`:

| Question | Decision | Record |
|---|---|---|
| Centralized vs local-first trust model | **Local-first.** Data lives on members' devices; discovery is relational (through coalition mates), never a global directory | ADR-0001 |
| What counts as "minimum score met" | **Consent floor:** average ≥ 2.0 and fewer than 10% scoring 0 | ADR-0002 |
| Exact involvement levels and their permissions | **Co-Creator / Member / Collaborator**, checked through capabilities so per-group, Discord-style roles can come later without a rewrite | ADR-0003 |
| How conflicts resolve | **Every competing version goes on the ballot**, side by side | ADR-0004 |
| "TODO: Better word for 'Push'" | **Dispatch** | ADR index |

### New idea from the same session (proposed, not decided)

**Holonic promotion.** Members' articles rise by vote through nested coalitions, an expanding circle of holons. Reconcile itself is the outermost group: users co-edit its mission, vision, and values, and it can broadcast pieces that cleared every lower level to the whole user base. See ADR-0001 for the tensions to resolve first: association leaks in discovery, the broadcast path, capture of the top group, and the promotion math.

### Still open

Quorum, a reason requirement for a 0 score, a voting wait for new members, the tie rule when several versions pass, ballot size limits, signed ballots and verifiable tallies, and the messenger app.

## Decided later on 2026-11-07

System design, trust and safety, and product and stack decisions are recorded as ADR-0005 through ADR-0026. Highlights:
- Level names are now **Member** (follows), **Collaborator** (votes), and **Co-Creator** (votes and creates). This doc uses the old names above.
- The first pilot group is the founder's own circle.
- Business model: a gift economy (ADR-0025).
- Name: Reconcile as a distinctive mark, with reconcile.earth proposed.

## Decisions applied (2026-11-07, remaining sheet)

ADRs 0032–0040 in docs/adr record: GitHub private; staged entity (pilot → fiscal sponsor → own 501c3); blind credits; minimal eternal core; group-by-group coalition votes; holonic promotion with author ceiling and device-carried votes; optional front doors; per-group integration ladder; opt-ins by Proposal. Use cases in docs/use-cases.md.
