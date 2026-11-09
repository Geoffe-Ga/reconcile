# ADR-0065: Ballots Can Stand Aside, and Any Score Can Carry a Note

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it; [ADR-0074](0074-mvp-scope-revised.md) restores part of it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-four-lenses`, decision `dissent` (chose `stand-aside` and `words-any-score`)
- **Amends:** [ADR-0002](0002-consent-floor-vote-rule.md), [ADR-0037](0037-holonic-promotion.md); spec §4

## Context

adrienne maree brown, Eisenstein, and Bateson all observed that only a 0 asks for words, so objectors are the only people who speak, which makes them targets. Consent practice separates a concern, standing aside, and a block. The app collapsed all three into one score.

## Decision

1. **Stand aside.** For each version on the ballot, a voter can score 0–4 or choose **stand aside** ("I won't block this, and I won't back it").
   - A stand-aside **counts toward quorum**.
   - It counts toward **neither the average nor the share of zeros**.
   - A version with no scored ballots at all doesn't pass. If quorum is met but every voter stood aside on every version, the outcome is `none`.
2. **A note with any score.** Any score, and a stand-aside, can carry an optional note.
   - A 0 still **requires** a reason (ADR-0002).
   - A 1 prompts, without requiring it: "What would make this a 3 for you?"
   - *Assumption:* notes are capped at 280 characters. Longer free text makes writing style a stronger link between someone's identities (ADR-0009).
3. **Notes expire with ballots.** Every note, including reasons for a 0, is deleted with the ballot when the visibility window ends (ADR-0017; 30 days by default, ADR-0051). Checkpoints keep totals and the commitment, never notes. This spells out what ADR-0017 implied.
4. **Notes never travel.** When a ballot is carried to a higher level (ADR-0037), the device asks for a fresh note rather than copying one, as ADR-0037 already required for a carried 0.

## Consequences

- The `vote` body becomes `{version hash: 0–4 | "aside"}` and `{version hash: note}`. The tally, the Python and TypeScript implementations, and `protocol/vectors/tally/` all change before Epic 1 ships. New vectors cover all-aside ballots, quorum met only through stand-asides, and a 0 with no reason (invalid).
- The ballot commitment covers stand-asides, so a recount sees them.
- The consent meter (`DESIGN.md`) shows stand-asides as their own count beside the average and the zero share.

## Amendment (2026-11-08, decomposition details)

Note length is counted in Unicode code points after NFC normalization. Proposal titles and justifications of `removal` and `readmit` Proposals, removal responses, and suspension reasons expire the same way notes do ([ADR-0072](0072-protocol-details-for-decomposition.md)).
