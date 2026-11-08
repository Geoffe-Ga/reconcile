# ADR-0047: Three Versions per Ballot; Missed Quorum Lapses; Limits on Re-Proposing

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-governance-edges`, decisions `ballot-size`, `missed-quorum` (chose `lapse`, with the founder's note)
- **Refines:** [ADR-0002](0002-consent-floor-vote-rule.md), [ADR-0004](0004-competing-versions-go-to-ballot.md), [ADR-0021](0021-level-names-and-self-selection.md)

## Decision

1. **At most 3 versions on one ballot**: the original plus 2 competitors. This is fixed, not a group rule. A `version` event past the cap is rejected, and a fourth idea becomes a new Proposal after this one closes.
2. **A vote that misses quorum lapses immediately**, with outcome `none`. No extension, and no re-run at a lower bar.
3. **Noise is held down by limits on re-proposing,** following the founder's note: "a cap on re-proposing the same thing, plus a time-out, plus three open proposals at once." *Assumed numbers, stated rather than asked:*
   - **Cooldown:** a version whose exact content (the same normalized-text hash) lapsed or failed can't be proposed again for **14 days**.
   - **Cap:** the same content can be proposed at most **3 times in any 180 days**.
   - The existing limit of **3 open Proposals per person** (ADR-0021) still applies.
   - All three are ordinary group rules.

## Consequences

- Validation tracks lapsed and failed content hashes per group, needed for the cooldown and cap. Test vectors cover the 4th version, a re-proposal inside the cooldown, and a 4th attempt within 180 days.
- Feed ranking (ADR-0048) keeps busy groups readable.
