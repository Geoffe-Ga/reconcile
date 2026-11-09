# ADR-0069: Lapses Aren't Failures, Passes Are Celebrated, and the Pilot Asks About Relationships

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-four-lenses`, decision `learning` (chose `lapse-gentle`, `celebrate`, `relational-pilot`)
- **Amends:** [ADR-0047](0047-ballot-cap-quorum-reproposals.md), [ADR-0056](0056-pilot-plan.md)

## Decision

1. **A lapse isn't a no.**
   - A vote that misses quorum still lapses with outcome `none`, but it **no longer counts** toward the 14-day cooldown or the 3-in-180-days cap. Only failed votes count.
   - The result offers a one-tap **re-open** that re-proposes the same content. *Assumption:* the new window is twice the old one, up to the 90-day maximum.
   - The copy reads: "Not enough people weighed in. This isn't a no."
   - The limit of 3 open Proposals per person (ADR-0021) still keeps re-opens from flooding the feed.
2. **A pass is celebrated quietly.** The result of a passed Proposal shows the new canonical text full-width, with thanks to the authors of the winning version by display name. No counts, streaks, or confetti (`DESIGN.md`).
3. **The pilot also asks about relationships.** ADR-0056's success bar stays, and the week-2 and closing interviews add:
   - Did anyone change their mind about something?
   - Did disagreements end in a way people could live with?
   - Did anyone feel shut out?
   - Did relationships in the group get better, worse, or stay the same?

   The pilot write-up also lists **what we aren't measuring**, so a good loop count isn't mistaken for a good group.

## Not chosen

The non-binding "How are we deciding?" review every 6 months wasn't chosen. Groups can still propose rule changes at any time.

## Consequences

- Validation tracks only *failed* content hashes for the cooldown and cap. The test vectors change: a re-proposal right after a lapse is valid.
- Epic 6's acceptance criteria include the interview questions.
