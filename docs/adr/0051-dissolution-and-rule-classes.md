# ADR-0051: Dissolving a Group; Which Founding Rules Start Entrenched

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it; [ADR-0074](0074-mvp-scope-revised.md) restores part of it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-governance-edges`, decisions `dissolution`, `genesis-classes`
- **Refines:** [ADR-0015](0015-anti-capture.md), [ADR-0040](0040-group-opt-ins-are-governed.md)

## Decision

**Dissolution**
- **Dissolving needs the entrenched bar** (a Proposal with target kind `rules`, then a `dissolve` event).
- **Each device keeps a read-only archive by default**, and relay mailboxes are deleted.
- **The vote can add "wipe everywhere".** Devices honor it, and the UI says plainly that no app can stop someone who already kept a copy.

**Rule classes at genesis**
- **Entrenched:** the pass rules, quorum, eligibility, removal rules, steward and suspension rules, dissolution, and the entrenchment rule itself.
- **Ordinary:** vote windows, vouches required, the wait before voting, the re-proposal cooldown and cap (ADR-0047), and ballot expiry, tunable **from 7 to 90 days, default 30** (ADR-0017).
- **Opt-ins** follow ADR-0040: widening exposure is entrenched, narrowing it is ordinary.

## Consequences

- `genesis` records each rule's class. Validation applies the class's bar to every `rules-change`.
- A dissolved group can't be revived. Members keep their read-only copies.

## Amendment (2026-11-08, decomposition details)

Dissolution now uses its own Proposal target kind, `dissolve`, at the entrenched bar, instead of a `rules` target. The Circle → Fellowship switch is the one rule change made without a Proposal; it changes only rules no Proposal ever set ([ADR-0072](0072-protocol-details-for-decomposition.md)).

## Amendment (2026-11-09): The Template Switch Skips the Proposal Loop on Purpose

The Consequences above apply each class's bar to every `rules-change`. [ADR-0067](0067-genesis-templates.md)'s Circle → Fellowship switch changes rule values without a `rules-change` Proposal, so no bar applies to it. That's deliberate, not an oversight:

- **No one authors it.** The `genesis` event records the template, and the template says when the group outgrows it. Every device derives the switch from the log at the event that brings the group to 10 voting members ([ADR-0072](0072-protocol-details-for-decomposition.md) item 9).
- **It never overrides a vote.** It moves only rules still at the Circle default. Any rule the group set by Proposal keeps its value.

Every other rule change still needs a `rules-change` Proposal at its class's bar. The MVP defers Circles and the switch ([spec §12](../spec/phase-1/12-deferred.md)).

## Amendment (2026-11-11, #231): A Backup From Before a Dissolve Comes Back Read-Only

**The gap.** Every device that folds a `dissolve` archives the group and never names its mailbox again, so the relay's copy expires after 30 days (ADR-0057). A backup file made before the dissolve (#78), a second device's link (#96) or the relay backup (#97, refreshed once a day) can still hold the group as it was. Restored on a device that never had the group, after the relay's copy has expired, it reads no `dissolve`, so it came back live: the "can't be revived" above didn't hold for backups.

**Options weighed:**

| | Relay state | What the relay learns | Covers | Costs |
|---|---|---|---|---|
| 1. A relay tombstone, kept past 30 days | A new route and retention class | A per-group id that never rotates (#110 rotates mailboxes weekly to avoid one), when the group ended, and the IP of every device that checks it after any restore, so restores of one group link across months | Only as long as it's kept: a file can be any age | Relay work, a growing list of dissolved groups, and a relay that loses or withholds it reopens the gap |
| **2. Restored copies read only until they hear from the group** | None | Nothing new: the device sends what any restore already sends | Any copy, of any age | A quiet live group restored from an old copy waits for news, or an invite link |
| 3. Accept the gap | None | Nothing | Nothing | Any member's old file can partly undo a dissolve, and the app calls the group live |

**Decision: option 2,** confirmed by the founder on 2026-11-12, who accepted it as built (#332). It adds no relay state and no request, so it fits ADR-0001 best.

- **Every group a restore takes** (a backup file, a second device's link or the relay backup) comes back **read-only for now**, noting the relay minute its copy last synced. A copy whose log holds a `dissolve` comes back dissolved, as before.
- **While read-only for now,** the sync loop reads the group's mailboxes and sends nothing for it: no event, push, nudge, chat post or front-door page. A backup, link or relay backup leaves it out, as it leaves out an archive, since a copy of it would look current.
- **It comes back live** once a pass shows the relay still held everything since the copy, or something newer:
  - the pass's relay minute is within 28 days of the copy's, the margin #73 already uses under the relay's 30 days, so a `dissolve` since then would still be on the relay, inside the weeks the pass reads; or
  - the pass reads a record the copy didn't hold, received at or after the copy's last sync: anyone in the group posting anything; or
  - the person opens a new invite link from someone in the group (#73's merge). A device keeping the group read-only for any reason never makes one, so the link means a member's copy still takes new things.
- **A pass that reads a `dissolve`** archives the group as dissolved, as for any other copy.
- **The screens say so plainly:** group home explains why it only reads and how it opens, and offers Remove from this device.

**Consequences:**
- A copy restored within 28 days of its last sync reads read-only only until its first sync, a few seconds online.
- A live group quiet for over 28 days stays read-only on the restored device until someone posts or sends an invite link, and a missed key change (#98) older than 30 days now shows as read-only instead of failing silently. The invite link fixes both.
- **Still open, and accepted:**
  - A device that slept through the dissolve and 30 days more, with no restore, still holds the group live, and an invite link from it confirms another copy.
  - Records an offline member's device posted after the dissolve, before it read it, outlast the dissolve by as long as that device was away, and can confirm a copy restored then.
  - Both need a copy older than the relay's memory, and stay among such copies: devices that archived the group never read its mailboxes again.
- As above, no app can stop someone who kept a copy and changes the app.
