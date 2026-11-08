# Four-Lenses Review

- **Date:** 2026-11-08
- **Sheet:** `/decide` sheet `2026-11-08-reconcile-four-lenses`
- **Outcome:** ADRs 0064–0071

Before spec decomposition, four separate reviewers read the ADRs, the Phase 1 spec, `DESIGN.md`, and the use cases. Each reviewer worked through one thinker's published ideas: Charles Eisenstein, Douglas Rushkoff, Nora Bateson, or adrienne maree brown. The ideas were paraphrased, never quoted. A finding led the sheet when three or four of them reached it independently.

## What All Four Endorsed

- Local-first trust and growth only through people who already know each other, with vouching in person (ADR-0001, ADR-0014).
- A separate identity for each group (ADR-0009).
- Coalitions that pass group by group (ADR-0036).
- One calm daily digest and no engagement metrics (ADR-0054, `DESIGN.md`).
- Learning from people instead of from telemetry (ADR-0056).

## Findings and Decisions

| Finding | Lenses | Decision | Record |
|---|---|---|---|
| Ranking by early enthusiasm rewards quick takes | Rushkoff, Eisenstein, Bateson | Two tabs: **Quiet** (least heard, the default) and **Rising** | [ADR-0064](../adr/0064-feed-tabs-quiet-and-rising.md) |
| Only objectors are asked to speak, which makes them targets | brown, Eisenstein, Bateson | A stand-aside option, plus an optional note with any score | [ADR-0065](../adr/0065-stand-aside-and-ballot-notes.md) |
| Discussion sits in plaintext on outside chat services | all four | **Kept as decided:** link any chat (ADR-0011) | — |
| No way back after removal | brown | Readmission by an ordinary Proposal | [ADR-0066](../adr/0066-readmission.md) |
| One rule set for a family of four and a 200-person chapter | Bateson, brown, Eisenstein | Genesis templates | [ADR-0067](../adr/0067-genesis-templates.md) |
| A stigmatized exit plus unchangeable clauses is a double bind | Bateson, brown, Eisenstein | "Part ways," not "split" | [ADR-0068](../adr/0068-part-ways.md) |
| Low turnout is punished like opposition; success counts loops, not relationships | all four | Lapses aren't failures; passes are celebrated; relational pilot questions | [ADR-0069](../adr/0069-lapses-celebration-relational-pilot.md) |
| Per-read pay and ad-rate anchors make attention the currency | Rushkoff, Eisenstein | No per-read share; a cost-of-running anchor | [ADR-0070](../adr/0070-patronage-not-attention.md) |
| A founder-held tool for self-governance; broadcast as a capture prize | Rushkoff | A self-hosting grant and a community roadmap; reach stops at coalitions | [ADR-0071](../adr/0071-self-hosting-and-reach.md) |

## Considered and Not Chosen

These options were offered and declined. Revisit them only with new evidence, such as pilot interviews.

- An encrypted discussion thread on each Proposal.
- A "pause for repair" flag and a "what we tried" field on removal votes.
- Eternal Atoms that a group can retire at the entrenched bar.
- A concerns round before scoring opens.
- A non-binding "How are we deciding?" review every 6 months.
- Passing a dissolved group's balance on by vote instead of to its payee.
- A named human's sign-off on protocol and cryptography PRs.

## Small Fixes Applied Alongside

- Recovery-contact copy is framed as trust, never as growth (ADR-0008 amendment).
- Every ballot note, including the required reason for a 0, expires with its ballot (ADR-0017 amendment, ADR-0065).
