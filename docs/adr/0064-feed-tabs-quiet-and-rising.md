# ADR-0064: Two Feed Tabs, Quiet (Default) and Rising

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-four-lenses`, decision `feed` (the founder's own approach: "Slow doubts and fast enthusiasm both need a tab. Slow doubts should be default.")
- **Amends:** [ADR-0048](0048-feed-surfacing.md)

## Context

The four-lenses review (Rushkoff, Eisenstein, Bateson) found that ranking Proposals by early enthusiasm rewards quick takes over slow doubt, against `DESIGN.md`'s ban on engagement mechanics. The founder kept the enthusiasm signal but moved it out of the default.

## Decision

The group's open Proposals appear under two tabs. Both are computed on the device from the open ballots it already holds (ADR-0010). No server ranks anything.

1. **Quiet** (the default tab) puts the least-heard first:
   1. Proposals short of quorum, closing soonest first;
   2. then the fewest ballots;
   3. then the most ballots carrying a concern: a 0, a 1, or a stand-aside (ADR-0065).
2. **Rising** is ADR-0048's sort: how fast ballots arrive and how enthusiastic they are, weighted toward recent ballots.

Nothing is ever hidden. "Newest" and "closing soon" stay one tap away in both tabs. ADR-0048's "needs votes" pin is no longer needed, because Quiet leads with exactly those Proposals.

**Names.** The founder suggested "Fresh and Rising" and asked for better. *Assumption:* "Quiet" for the default, because the tab exists to surface quiet voices and slow doubts; "Fresh" reads as "newest", which isn't what the tab shows. The names are message-catalog copy (ADR-0055), so the pilot can change them without an ADR.

## Consequences

- The client engine (`src/engine`) exposes two pure, unit-tested ordering functions. Every device computes the same order from the same log.
- The tab choice is remembered per device. It's a local preference, never synced.
