# ADR-0017: Need-to-See Visibility and Ballot Expiry

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-trust-safety`, decision `leaks`

## Context

The likeliest breach is an infiltrator who screenshots what members can see. Nothing technical stops copying, so the lever is how much each level sees and for how long.

## Decision

- **Pseudonymous display names by default.** Nobody is asked for a real name.
- **Followers (Members) don't see the roster.** Collaborators and Co-Creators see display names only.
- **Individual ballots are visible while voting is open and for 30 days after the tally** (a default each group can tune). After that, devices drop who voted what and keep the totals plus a hash commitment to the full ballot set. This refines ADR-0010: open during the dispute window, minimized after it.
- **Proposed for after the MVP:** tiered visibility, meaning Atoms and discussions visible only to Co-Creators.

## Consequences

- An old tally can be checked against its commitment but not recounted from scratch.
- The UI states that a screenshot taken during the window survives expiry.

## Amendment (2026-11-07): Checkpoints for Newcomers

Someone who joins after ballots expire can't recount old tallies from the votes. When ballots expire, a voting member's device writes a signed **`checkpoint`** event to the log. It holds the totals, the ballot commitments, and the hash of the log prefix it summarizes. A newcomer verifies the log from the checkpoint forward and accepts the checkpoint itself on the signatures of the members who vouched them in (ADR-0014). If two checkpoints for the same prefix disagree, the conflict is shown to the whole group. Spec §4 has the event.
