# ADR-0057: Staging and Production; Versioned Protocol Changes; Relay Retention

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-pilot-ops`, decisions `environments`, `updates`, `retention`
- **Builds on:** [ADR-0041](0041-digitalocean-relay-hosting.md), [ADR-0043](0043-recovery-and-backup.md)

## Decision

**Environments**
- Two small DigitalOcean VMs, about $10–12 a month together.
- A merge to `main` deploys to **staging** automatically.
- **Production** deploys only when the founder pushes a release tag.
- Each VM gets its own scoped deploy key.

**Updates**
- App-only changes install in the background and apply on the next launch.
- **The validation rules change only through a new protocol version `v`, never retroactively.** Devices reject events with an unknown `v` and show "Update Reconcile to keep up with your group."
- Old events keep validating under their own version's rules. Every version has its own test vectors.

**Retention**
- Mailbox blobs: **30 days**, as already in spec §6.
- Backups: deleted **180 days** after their last refresh.

## Consequences

- Epic 2 issue 6 (deploy) covers both environments and the tag-triggered production deploy.
- The founder creates and pays for both VMs (ADR-0041).
- Validators dispatch on `v`. Vectors live in `protocol/vectors/v1/` and so on.

## Amendment (2026-11-08, decomposition details)

Backups use their own endpoint, `/v1/backup/{id}`, with the 180-day retention above. Expiry times are rounded to the day. CI smoke-tests staging after each deploy, without blocking merges ([ADR-0072](0072-protocol-details-for-decomposition.md)).

## Amendment (2026-11-13): A Coalition's History Travels in Its Group's Invite (#279)

**Decided by an agent, with the coordinator's approval, under the founder's standing "go with your recommendations" instruction. The founder hasn't reviewed it yet.**

### Context

The relay keeps a coalition's weekly mailboxes 30 days, as it keeps a group's. A group's newcomer still reads everything, because the invite carries the group's whole log (#73).

A coalition had no equivalent. Someone who joins a seated group gets the group's reconcile Proposal, which holds the coalition's secret, but not the coalition's own log: its genesis, joins, motions, results and room wraps. A coalition entry read for the first time reads only its last two weeks. So once a coalition is a couple of weeks old, a newcomer's device never folds it: it doesn't show as formed, and Take part never joins. The same happens to a member's device that was away while the coalition formed.

### Options considered

| | What the relay learns | Who must be online | Growth | Fold change |
|---|---|---|---|---|
| 1. Sealed chunks of the coalition log in each member group's log | Large blobs land in every member group's mailbox whenever the coalition grows, at similar times and sizes, which links the groups | A participant, after every change | Every group's log duplicates the coalition's, forever | A new event type |
| 2. Participants re-post the genesis and current state | Periodic re-posts | A participant, at least every two weeks | Unbounded copies at the relay | **Unsound** (below) |
| 3. A card-style envelope a participant makes when someone taps Take part | A request, then another device's reply, a pair it can time | A participant, when asked | None | A new request event |
| **4. Chosen: the group's invite carries the logs** | Only a larger invite, which lives a day. No coalition mailbox is named and no new timing appears. | Only the inviter, who is online anyway | None at rest | None |

**Option 2 fails because a re-posted record gets a new relay `seq` and `received`.** A coalition's deadlines, early closes and the deadline + 10,080 minutes during which results count all run on `received`. So a newcomer folding the re-posted copies would decide motions differently from everyone else. Records are content-addressed, so a device that already holds one drops the re-post as a duplicate, and only newcomers would see the moved receipts. Re-posting only the records about to expire fails the same way.

### Decision

- **The invite carries the logs.** An invite to a group carries, after the group's log, the relay-accepted log of every coalition the group reaches (`coalitionKeys`: nested ones through the coalition below them, nearest first), in the same chunks with the same receipts.
  - The header's `coalitions` names each one: its secret and its chunk count.
  - It carries at most 32, and none whose log is empty. A coalition this device only follows by its link isn't one the group reaches, so it stays out.
  - A group in no coalition writes no `coalitions`, so its invite is as before.
- **Join keeps them.** It keeps each carried coalition the group reaches, judged with the carried logs themselves, through sync's verify and dedupe, as Bring keeps a card's log.
- **Merging catches up.** A device already in the group merges them in, as it merges the group's. So spec §7's "Open a new invite link from your group to catch up" now catches up a coalition too.
- **Nothing for an archive.** A removed or dissolved archive keeps no coalition, so a device that holds the group as one keeps nothing an invite carries.

**Privacy.** Nothing new reaches a person. Anyone who opens a live invite already holds the coalition's secret, which the group's log carries (ADR-0075 §1). The relay sees an invite of more 64 KB blobs, sealed under the one-day invite key, and no coalition mailbox id.

### Accepted pilot risks added

- **An older app reads such an invite as damaged.** The envelope has no version field, and opening is all or nothing. An app from before this change finds more blobs than the header counts, and says the link has expired or is damaged until it updates, which it does in the background at its next launch. Invites from groups in no coalition don't change. The envelope's earlier changes (#98's epoch, #269's kept mark) were handled the same way.
- **A newcomer inherits the inviter's gaps.** The invite carries what the inviter's device holds, so a gap there, such as a device that was itself away while the coalition formed, passes on. Any member whose device holds the whole log can make a fresh invite.
- **Larger invites.** An invite grows by the logs of its group's coalitions. The relay takes up to 64 MiB per mailbox, and an invite lives one day.
