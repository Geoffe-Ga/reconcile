# ADR-0072: Protocol Details Settled During Decomposition

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it; [ADR-0074](0074-mvp-scope-revised.md) restores part of it.
- **Date:** 2026-11-08
- **Decided via:** spec decomposition of Phase 1 (the 2026-11-08 issue drafts). The drafting agents found these gaps; each was decided under the founder's standing rule: decide, state the assumption, continue.
- **Refines:** [ADR-0006](0006-signed-log-plus-crdt.md), [ADR-0017](0017-need-to-see-and-expiry.md), [ADR-0043](0043-recovery-and-backup.md), [ADR-0049](0049-stewards-and-removal.md), [ADR-0051](0051-dissolution-and-rule-classes.md), [ADR-0054](0054-digest-notifications.md), [ADR-0057](0057-environments-updates-retention.md), [ADR-0065](0065-stand-aside-and-ballot-notes.md), [ADR-0066](0066-readmission.md), [ADR-0067](0067-genesis-templates.md); spec §4, §6, §7

Validation must be deterministic: every device reaches the same verdict from the same log, whatever its own clock says. Each item below is chosen to keep that property.

## Time and versions

1. **Time is the author's `ts`, constrained by causality.** An event is invalid if its `ts` is earlier than any parent's `ts` in `prev`. Every duration (invite expiry, the wait before voting, vote windows, cooldowns, suspension) is measured in `ts`. A device's own clock is used only to *display* a warning on an event dated more than 10 minutes in its future, never to judge validity.
2. **A vote counts only if it is in the tally's causal past and its `ts` falls inside the window.** If several valid `tally` events exist for one Proposal, the first in total order is canonical and the rest are ignored.
   - *Accepted risk for Phase 1:* a voter could backdate a ballot while referencing only old parents. Ballots are open and groups know each other, so this is visible. The outside review (ADR-0058) revisits it.
3. **Event versions.** The validator, not the relay, checks the envelope `v` (ADR-0057). An event with a higher `v` than the device understands is kept, marked "needs an update", and excluded from state until the app updates. The relay versions only its HTTP path (`/v1/`).

## Ballots and Proposals

4. **Lengths are Unicode code points after NFC normalization**, which both implementations count identically:
   - notes: 280;
   - Proposal titles: 120;
   - justifications: 2,000;
   - `removal-response`: 1,000;
   - suspension reasons: 280.
5. **Sensitive free text expires.** Titles and justifications of `removal` and `readmit` Proposals, `removal-response`, and suspension reasons expire with the ballot window of the vote they belong to. A suspension that never reaches a vote expires 30 days after it ends. Checkpoints keep none of them. This extends ADR-0065's note expiry and ADR-0066's "no harm narrative" to every field that could carry one.
6. **A re-open names what it re-opens.** `proposal` gains an optional `reopens` field holding the lapsed Proposal's id. It's valid only if:
   - that Proposal lapsed;
   - the version hashes match;
   - the window is at most twice the lapsed window, capped at 90 days;
   - no other re-open of the same lapse exists.

## Membership and lifecycle

7. **Readmission is bound to one person and one invite.** A `readmit` Proposal names the removed member's old group key. After it passes, a Co-Creator issues an `invite` that carries the `readmit` id with `max_uses` 1. A `join` citing a `readmit` id is valid only through that invite, and only once.
8. **A Circle's template beats the size rule.** A Circle has 1 steward seat with no term at any size up to the switch. At 10 voting members it becomes a Fellowship, and ADR-0049's seats and terms apply.
9. **Rule provenance.** Group state records, per rule field, whether a passed `rules-change` ever set it. The Circle → Fellowship switch changes only fields never set that way. The fold applies it at the event that brings voting members to 10. It is the one rule change that doesn't need a Proposal (ADR-0067); ADR-0051's classes otherwise apply.
10. **Dissolution has its own target kind:** `dissolve`, at the entrenched bar. ADR-0051's routing through a `rules` target is replaced, because a named kind is clearer to validate and to read.
11. **Keys rotate on both `remove` and `leave`** (spec §6). The §4 event table is corrected to match.
12. **Seeing the roster is a capability:** `see-roster`, held by the voting levels (Collaborator and Co-Creator). Members (followers) don't hold it (ADR-0017).

## Relay, backup, and notifications

13. **Backups have their own endpoint:** `PUT` / `GET /v1/backup/{id}`, with 180-day retention after the last refresh (ADR-0057). The relay learns only that an opaque, padded blob is a backup. Its schedule and fixed size already reveal that much.
14. **Expiry times are rounded to the day**, so stored rows don't record exact write times.
15. **Lock-screen text is generic.** The digest notification says only "Reconcile: you have updates", with no group names, counts, or titles. A recovery attempt says "Reconcile: a recovery was started for your account. Open the app to review." A seized or shoulder-surfed phone learns nothing more.
16. **Staging is smoke-tested by CI after each staging deploy.** The job is informational and never blocks a merge. A failure files a P1 issue. Production deploys from a tag only after the latest staging smoke run passed.

## Consequences

- Spec §4 (event table, rules, tally), §6 (relay API), and §7 (notifications) are updated to match.
- New test vectors:
  - a parent with a later `ts` (invalid);
  - two tallies for one Proposal;
  - a backdated vote outside the tally's causal past;
  - lengths at exactly the cap and one past it, with combining characters;
  - a second re-open of one lapse;
  - a `readmit` join through the wrong invite;
  - a Circle switching with one rule already changed;
  - an event with a higher `v`.

## Amendment (2026-11-09): Events That Build on an Unknown-Version Event

Item 3 didn't say what happens to a later event that builds on an event the device leaves out of state ([#48](https://github.com/Geoffe-Ga/reconcile/issues/48)). The MVP's rules already answer it, so this amendment adds no new rule:

- **The MVP has no `prev`.** [ADR-0073](0073-mvp-scope.md) defers it, and [ADR-0074](0074-mvp-scope-revised.md) keeps that architecture. Events apply in relay order, and an event builds on another only by naming its id. A vote, for example, names its Proposal.
- **ADR-0073 ignores unknown event versions.** An event with a `v` the app doesn't understand changes nothing. Its record stays in the device's log, as item 3 requires, because sync keeps every record that opens.
- **An event that names an ignored event is ignored too.** Each event is checked against the state that the events before it produced ([ADR-0006](0006-signed-log-plus-crdt.md); [the spec's fold](../spec/phase-1/04-events/02-the-fold.md), step 5), and the event it names isn't in that state. So state never applies an event to a missing target.
- **Updating the app applies both.** State is a fold over every record in the log. Once the app understands the newer `v`, the next fold applies that event and the events that name it.
- Until a device updates, its state can differ from an updated device's. Item 3 already accepts that cost.

**Test vector,** landing with the MVP engine's fold vectors (#63): a Proposal with `v: 2` and a `v: 1` vote on it are both ignored, and state is unchanged.

**When `prev` returns** (ADR-0006's hash-linked log), the ADR that restores it decides what happens to an event whose `prev` includes an unknown-version event.
