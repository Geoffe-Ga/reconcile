# ADR-0036: Coalition Decisions Pass Group by Group

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-remaining`, decision `coalition-voting`
- **Builds on:** [ADR-0009](0009-per-group-identities.md), [ADR-0010](0010-open-ballots-with-exit.md)

## Decision

- Every member group votes on a coalition motion **inside the group, under its own consent floor** (ADR-0002).
- **Only a signed pass or fail result crosses group lines.** No individual ballot, voter identity, or score leaves a group.
- **Threshold (assumption, from the sheet's lean):** coalitions of up to 4 groups need every group to pass. Coalitions of 5 or more need two-thirds of their groups, so one group can't block forever. The threshold is a coalition rule, changed by a coalition motion.
- Forming a coalition (the reconcile vote) always needs every founding group to pass.

## Why

It's the only option that keeps every ballot in its group and protects small groups from being outvoted by large ones. Protecting small groups is the reason to reconcile at all.

## Consequences

- This settles "secret ballots for coalition-wide votes": there are no coalition-wide individual ballots.
- A group that is repeatedly outvoted under the two-thirds rule can leave the coalition. Split petitions follow ADR-0015.
- New log event for Phase 2: a signed `group-result`, which a coalition's log accepts from each member group.

## Amendment (2026-11-14, #250, #387): A Pass Is Final When Every Group's Vote Has Closed, and Each Level Stops a Day Before the One Above

- **Decided by:** the founder, 2026-11-14 (sheet `2026-11-14-coalition-horizons`), and the reminder's scope on 2026-11-19, recorded in #539.
- **Settles:** #250 (finality and formation) and #387 (staggered horizons).

### Context

#100 made a coalition's pass final at its deadline plus 7 days, so that a `pass` forged early by anyone holding a group's seat secret is replaced by the group's real result before it counts. It also gave a coalition 21 days from its genesis to form (`formsBy`). #122 nested coalitions with the same horizon at every level, so a lower coalition's pass had to cross as soon as it was certain, and #375 found that a contest after that left the level above depending on when the lower coalition's devices synced. #375's fix, a withdrawn pass that crosses as a fail, made the level above fail-safe but still timing-dependent: a lower coalition that recovered to a pass after its fail had crossed was still counted as failing.

### Decision

1. **The gap `g` is 1 day** (`HORIZON_STEP_MINUTES` = 1,440, replacing `RESULT_GRACE_MINUTES`' 10,080). For a motion with deadline `D`, results count in a level-`k` coalition while their receipt is before `D + k·g` (`horizonOf`, `motionHorizon` in `client/src/engine/coalition.ts`). A group's horizon, at level 0, is its deadline. A motion keeps the level its coalition had when it opened there, so an admission that raises the coalition's level never moves an open motion's horizon.
2. **A pass is final at its horizon; a fail is final at once.** A coalition of groups is final a day after its deadline, and three nested levels three days after. Everything that waited a week now waits for the horizon: the coalition's text changing, its Dispatches, an admission taking its seat, and #323's promotions (`advancePromotions`; `groupRising` and `coalitionRising`, passed once final and owed up until a day past the horizon; `promotionsOwed`; and a carried score's last decision in `store/carry.ts`).
3. **Only final outcomes cross up a level** (#387, option B). A coalition reports a motion, a promotion record or the genesis above only once its own outcome there is final, as a group does. #375's withdrawn-pass rule is deleted: a coalition never crosses a pass that isn't final, so there is none to withdraw. A pass for its seat forged by a holder of its seat secret is answered by its own final result, as for a group's seat.
4. **Formation is final once every founding vote must have closed:** `formsFinal = genesis + 14 days + level·g`, replacing `formsBy`. Until then a founding seat's fail declines the coalition, even after it formed.
5. **Close-out:** a coalition still forming at `formsFinal` is declined for every founding group, and relay time stops there. That closes the path where a seat-secret holder forms a coalition with a forged late pass for a group whose own result never crossed.
6. **Reminder:** a member who hasn't scored an open reconcile or coalition vote is reminded 3 days before it closes: "If you don't vote by <date>, you won't be counted." Reconcile and coalition votes only, not every Proposal. The push is a nudge like the vote's other two, at the same shift (#284's group offset for a coalition motion), and carries nothing (ADR-0012): the words show only in the app, on the device of a member who hasn't scored it.
7. **Screens:** "Currently not passing" shows on the group's own line of a forming coalition's row, only while its reconcile vote is open and someone has scored it, and never for another group. Once another founding group's fail declines a coalition, a group's still-open reconcile ballot is replaced by "<group> didn't pass this, so the coalition won't form."

### Why

- A week's wait was the price of one defence: a forged early pass is harmless as long as the group's own result crosses before results stop counting. A day keeps that defence for any group one of whose participants opens Reconcile within a day of its vote closing, and the deadline's nudge (#284) prompts them to.
- **Order and timing independence, by induction on levels.** A level's outcome at its horizon depends only on its seats' results, each seat counted once, a fail winning (`seatResult`), so their order doesn't matter. Each seat's result is final when it crosses. A coalition is always one level above every seat it holds, so any crossing in `[horizon(seat), horizon(above))` lands while results still count above. So every level's final outcome is a function of the groups' final outcomes alone, whenever each device syncs. #375's counterexample (five seats, four early passes, then a contest) can no longer cross anything early.

### Options weighed

- **#250 §1, finality:** (A) keep 7 days after the deadline; (B) the group's own vote window plus a short gap, **chosen** with `g` = 1 day; (C) each group's pass cites its Proposal and close time, which needs a proof the coalition can check without reading the group.
- **#250 §2, formation:** keep the 21-day `formsBy`, or none at all; **chosen:** final at `formsFinal`, with the close-out at that minute.
- **#387:** (A) a withdrawn pass crosses as a fail (built in #375, now retired), or (B) staggered horizons, **chosen**.

### Consequences

- A coalition change lands a day after its deadline instead of a week, and up to three days for three levels.
- A group none of whose coalition participants opens Reconcile within a day of its vote closing counts as not passing (fail-safe). For a coalition of coalitions, its participants must cross within a day of its own horizon.
- A coalition that hasn't formed 14 days plus a day per level after its genesis is declined; its groups can reconcile again with a new card.
- Pinned by `vectors/nested-horizons.json` (each level's horizon, #375's five-seat case, its recovery, a forged early pass, and `formsFinal`'s close-out at level 2), the re-timed `coalition-*`, `nested-*`, `promote-*` and `follow-dispatch` vectors, and the fast-check property that every level of three decides the same whatever the order and timing of results, at any seat count.
- ADR-0057's "deadline + 10,080 minutes during which results count" now reads as the horizon.

### Privacy

Nothing new leaves a group's log or reaches the relay. A motion's level and `formsFinal` are folded state, not records, and a withdrawal is derived from the log every device folds, so it adds no event. The reminder is one more content-free nudge at a minute shifted as the vote's others are, from the devices that nudge it already, whether or not anyone has scored it, so its timing says nothing of who has voted. "Currently not passing" is read from the group's own ballots on its own members' devices. The coalition graph is no more enumerable than before.
