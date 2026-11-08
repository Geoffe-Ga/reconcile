# ADR-0037: Holonic Promotion: Each Level Decides; Votes Travel With the Dispatch

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-remaining`, decision `holonic-promotion` (chose `level-by-level`, with the founder's notes)
- **Resolves:** the proposal in [ADR-0001](0001-local-first-trust-model.md); builds on [ADR-0036](0036-coalition-each-group-passes.md)

## Decision

1. **Each level decides under its own rule.** A group under the consent floor; a coalition group by group (ADR-0036). Passing creates a signed promotion record, and the next level up takes it up.
2. **The author sets a ceiling**, chosen when they create the Dispatch:
   - this group only
   - one level up
   - two levels up
   - as far as it can go, including Reconcile-wide broadcast
   No level can promote past the ceiling. **Assumption:** the author may lower the ceiling at any time but never raise it once voting has started, because people voted knowing how far it could go.
3. **No re-votes. The vote belongs to the Dispatch, not to the group where it was cast.** A ballot follows the Dispatch up the holarchy for as long as the person who cast it is an eligible voter at the higher level. Nobody is asked to vote twice on the same Dispatch.
4. **Broadcast to everyone** ("as far as it can go") also needs Reconcile-the-group's stewards plus a final vote there. It then goes out on a public, signed feed that apps fetch for themselves, so nobody learns who received it.

## How a Vote Travels Without Crossing Group Lines

A literal reading of (3) would copy individual ballots from one group into another. That would link a person's per-group identities (ADR-0009) and move ballots across group lines (ADR-0010, ADR-0036). So **the voter's own device carries the vote**:

- The Dispatch has a stable id at every level.
- When it arrives for a vote in a higher group, the voter's device sees it already holds this person's ballot for that Dispatch. It casts the same score under the person's identity in the higher group. The person isn't prompted. They can change it within the window.
- Membership in the higher group is the only thing that makes this possible, which is exactly the condition in the founder's note.
- The originating group's result carries up as a group decision (ADR-0036). Individual ballots never do.

Guarding against linkage:

- Carried ballots are cast at a random time within the window, not the moment the Dispatch arrives.
- **A carried 0 needs a fresh reason.** The device asks rather than copying text, because identical wording would link the two identities.

## Consequences

- The Dispatch event gains a `ceiling` field and a stable `dispatch_id` (Phase 2 or 3 log events: `promote`, `promotion-result`).
- Ballot expiry (ADR-0017) deletes the group's copy after 30 days. The voter's device keeps its own ballot until the Dispatch's ceiling is reached or it expires.
- Coalition tip shares (ADR-0027) attach to the promotion record.

## Amendment (2026-11-08, four-lenses review)

The "as far as it can go, including Reconcile-wide broadcast" ceiling and item 4 are withdrawn: the highest ceiling is "as far as the coalitions go" ([ADR-0071](0071-self-hosting-and-reach.md)). Carried ballots never copy notes ([ADR-0065](0065-stand-aside-and-ballot-notes.md)). Coalition tip shares no longer attach to promotion records ([ADR-0070](0070-patronage-not-attention.md)).
