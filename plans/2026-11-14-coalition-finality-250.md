# Plan: #250 coalition finality and formation, #387 staggered horizons

Branch: `claude/zealous-edison-kk4qx6-250-coalition-finality`. The plan was written against main at 8036304; the branch now starts from a later main.

**Status: unblocked (2026-11-14).** The founder answered Q1 and Q2 and chose a close-out and a reminder (below). Every formula below takes `g` = 1,440.

**Built for #539 on `prep-539`, from main at 6c8e7ed** (after #467, ADR-0081's listed doors, #480, #493 and #501). Every file and line reference below was re-checked there and now points at main at 6c8e7ed: `coalition.ts`, `coalitionProgress.ts`, `history.ts` and the app files hadn't moved, `crossing.ts` had moved by four lines, `fold.ts` had grown, and `store/carry.ts` `decisions` sits at `:184`. #501's changes to `frontDoor`, `rules`, `fold` and `optIns` touch nothing here. Where this plan and #539 differ, #539 wins: the close-out at `formsFinal` is built, so `expireFormation` stays, and the reminder covers reconcile and coalition votes only. §6 says what was built.

**Founder's answers (2026-11-14, sheet 2026-11-14-coalition-horizons):**
- **Q1 g = 1 day** (`HORIZON_STEP_MINUTES = 1,440`).
- **Q2 = (a):** genesis results count until `formsFinal = genesis + 14 × 1,440 + level × g`.
- **Close-out, built now:** a coalition **still forming at `formsFinal` is declined** for both groups. This replaces "keeps forming with no deadline" in §2's Formation, and closes the forged-late-pass path.
  - Keep `expireFormation` and its `advanceTo` and `endTime` calls, now at `formsFinal`.
  - Keep a row line for it, reworded from "Not every group voted in time." in DESIGN.md's voice.
- **Reminder, built now:** a member who hasn't scored an open reconcile Proposal is reminded 3 days before it closes: "If you don't vote by <date>, you won't be counted."
  - **Scope:** reconcile and coalition votes only (the founder, 2026-11-19).
  - The push stays content-free (ADR-0012): only the wake goes out, and the words show in the app.
  - Reuse #284's nudge offset mechanism.
- **Q3 defaults stand.**

---

## 0. Questions for the founder (blocking)

### Q1. After a level's vote closes, how long do its results still count one level up? (`g`, in minutes)

Decision 1 says a coalition's pass is final "once each group's own vote window has closed". But a group's copy of a motion closes at the motion's deadline at the latest (`fold.ts` `openMotion` gives every group the coalition's `deadline`). The group's `group-result` can only reach the coalition's log **after** that, when one of the group's coalition participants next opens Reconcile: sync runs only while the app is visible (spec §7, `POLL_MS`). If results stopped counting at the deadline itself, a group whose vote runs its full window could never report, and every such motion would fail.

So results must go on counting for some time `g` after the groups close, and the pass is final only once `g` is up. #387's stagger adds `g` again at each level, because each level crosses only its final outcome, after its own horizon. Nothing in the decisions says how long `g` is. Today it's 7 days (`RESULT_GRACE_MINUTES`). Keeping 7 days per level would leave a one-level coalition exactly where it is (option A, not B) and push a three-level one out to 21 days.

`g` also sets the protection #250 §1 relies on: a forged early `pass` for a group, posted by anyone holding its seat secret, is harmless only if the group's own result reaches the coalition within `g` of its close.

| `g` | Coalition of groups: pass final | 2 levels | 3 levels | A group must report within |
|---|---|---|---|---|
| **1 day (1,440)**, recommended | deadline + 1 day | + 2 days | + 3 days | 1 day of its close |
| 2 days (2,880) | + 2 days | + 4 days | + 6 days | 2 days |
| 3 days (4,320) | + 3 days | + 6 days | + 9 days | 3 days |
| 7 days (10,080), today's grace | + 7 days (unchanged) | + 14 days | + 21 days | 7 days |

- **Cost of a short `g`:** if none of a group's participants opens Reconcile within `g` of its vote's close, the coalition counts the group as not passing (fail-safe). For a coalition of coalitions, the coalition's participants must open it within `g` of the coalition's own horizon.
- **Help that's already there:** a group's devices post a push nudge at `deadline + o` for the group's result (#284). Nothing wakes anyone at a coalition's horizon, and adding a wake there would be a privacy change (ADR-0075 §2), so this plan adds none.
- **Recommendation: 1 day.** It's closest to "final once each group's vote has closed", and the deadline nudge prompts the people who need to open the app.

### Q2. With `formsBy` gone, how long can a founding group's `fail` still undo a coalition that has formed?

Today, results on the genesis count until `formsBy` = genesis + 14 days + 7 days. Until then, any founding seat's `fail` declines the coalition, **even after it formed** (a contest), and a coalition still forming at `formsBy` is declined (`coalition.ts:340`, `:579`). Decision 2 drops the clock decline: a forming coalition withdraws only when a founding group's vote closes without a pass. That leaves open when results on the genesis stop counting once it **has** formed:

- **(a) Recommended: until every founding group's own reconcile vote must have closed, plus the gap.** The MVP fixes every group's ordinary window at 3–14 days (no rule changes windows), so every founding group's vote has closed by genesis + 14 days. The formation is then final at `genesis + 14 × 1,440 + level × g`, the same rule as decision 1, applied to forming. A coalition still forming then keeps forming with no deadline (decision 2), and once it forms later it's final at once.
- **(b) Not at all:** final the moment the last founding group passes. Simplest, but anyone holding a seat secret could then post an early forged `pass` and form a coalition before their group has voted, the threat #250 §1 names.
- **(c) For the coalition's whole life:** today's rule with no end. Any seat-secret holder, former members included, could undo a long-standing coalition at any time.

**One cost that's the same in every option:** with no deadline to form, a group that never reports keeps its coalition forming indefinitely. #250 named this risk, and decision 2 accepts it. It also means a seat-secret holder can, at any later time, post a forged `pass` for a founding group whose own result never crossed, and form the coalition. Today the 21-day decline closes that path. **Is that accepted?**

### Q3. Confirm (not blocking: I'll build the default unless told otherwise)

1. **"Withdrawn for both groups."** The engine already declines a forming coalition only on a crossed `fail`, which a device posts only once its group's reconcile vote is final (`crossing.ts:179` `genesisResult`). So a provisional count never withdraws anything today, and the only engine change decision 2 needs is dropping the clock decline. **Default:** the other founding group's reconcile ballot stays open in its own log, which no device can close without a new event there. On screen it's withdrawn: its Proposal page shows "<group> didn't pass this, so the coalition won't form." in place of the ballot, and group home's row reads "Didn't form" in both groups, as today.
2. **When "currently not passing" shows.** **Default:** on the group's own line in a forming coalition's row, while the group's reconcile vote is open, at least one member has scored it, and its live outcome isn't a pass. It doesn't show before anyone has scored, when every open vote reads as not passing yet. Only the group's own devices can see their own count, so the line never shows for another group (ADR-0036: only pass or fail crosses).

---

## 1. Current rules and where they live

| Rule | Where |
|---|---|
| Results on a motion count while `received < deadline + 10,080` | `engine/coalition.ts:31` `RESULT_GRACE_MINUTES`; `:471` `resultsEnd`; `:482` `resultsCount`; checked in `:498` `mayReport` |
| A pass is final at `deadline + 10,080`; a fail at once (closes the motion) | `coalition.ts:39` `settlesAt`; `fold.ts:2856` `settleMotion`; `fold.ts:2013` `applyGroupResult` (fail closes at its receipt) |
| A motion opens in every log below with the **same** deadline | `crossing.ts` `motionsFor`; `fold.ts:3546` `openMotion` (snapshot `{id, deadline, seats, admit}`) |
| A coalition's pass crosses up as soon as **certain**, not final | `crossing.ts:201` `motionResult` (`group.coalition !== null && pass`); `fold.ts:3498` `heldOutcome(…, certain)` for a coalition's reconcile motion; `crossing.ts:179` `genesisResult` reads it |
| A withdrawn pass crosses as a fail (#375's option A) | `crossing.ts:351` `withdrawnPass`, used in `:375` `resultsToReport` |
| Formation: forming → formed when every founding seat passes; declined at any founding seat's fail, even after forming, while genesis results count | `coalition.ts:519` `recordResult`; `:568` `formation` |
| `formsBy` = genesis + `windows.ordinary.max` days + 10,080; still forming then → declined there, and relay time stops | `coalition.ts:340` `newCoalition`; `:579` `expireFormation`; `fold.ts:3484` `endTime`; `fold.ts:3666` `advanceTo` |
| A coalition motion's Dispatch goes out at `deadline + 10,080` | `fold.ts:3170` `advanceMotionDispatches` |
| An admitted seat takes its seat at `deadline + 10,080` | `fold.ts:3580` `advanceAdmissions` |
| **#323 (merged as c17a050):** a promotion goes out at a coalition at `deadline + 10,080` | `fold.ts:3602` `advancePromotions` |
| #323: a coalition's promotion motion counts as passed below once **certain**; records go up until `deadline + 10,080` (a group's: `close + 10,080`) | `crossing.ts:235` `groupRising`, `:251` `coalitionRising`, `:319` `promotionsOwed` |
| #323: a voter's carried score is kept until the last decision, a coalition's dated `deadline + 10,080` | `store/carry.ts:184` `decisions` |
| A motion's decided day, on the coalition home and in History | `engine/coalitionProgress.ts:80` (`settles`, `final`); `engine/history.ts:286` `decidedAt`; `app/coalitionHome.ts:233` |
| "Takes effect on <day>" | `app/CoalitionProgress.tsx:50`, `:110` |
| Row line "Not every group voted in time." (clock decline) | `app/coalitionLines.ts:30`, `:134`; `app/CoalitionSection.tsx:56`; `messages.ts` `coalitions.lapsed` |
| Test helper's horizon | `test/coalitions.ts:233` |

## 2. The new rules, as predicates

### Notation

- `D(m)`: motion `m`'s deadline, `received + window × 1,440`, set by the coalition whose motion it is. Every log's copy keeps it. **Groups' ballots, early close and nudges don't change.**
- `level(X)`: 0 for a group; for a coalition, its `coalition.level` (1–3) **when `m` opened there**, kept on the motion's snapshot as `MotionSeats.level` (new field). A coalition's level can rise when it admits a higher seat (`admitSeat`), and a horizon mustn't move once a motion is open.
- `g`: `HORIZON_STEP_MINUTES` (Q1), replacing `RESULT_GRACE_MINUTES`.

### "A group's vote closes", in the logs

- **In the group's own log:** its copy of `m` closes at `closeTime(p) = p.closedAt ?? p.deadline`, either the early close (every eligible member has scored every version, `fold.ts` `applyVote`) or `D(m)`. Ballots can be replaced until then. That's unchanged.
- **In the coalition's log:** the coalition never sees a group's ballots or its close. What it holds is the seat's `group-result`, which an honest device posts only once the group's copy is final (`motionResult`, `genesisResult`). "Group X's vote closed without a pass" means **a `fail` from X's seat is recorded** while results on `m` count. "Group X hasn't reported by the horizon" means its seat counts as a fail once expired (unchanged `coalitionOutcome`).

### Horizons (#387), in minutes

For a motion `m` in a coalition `X` at level `k = level(X)`:

```
horizon(m, X) = D(m) + k × g
```

- Results on `m` count in `X` iff `received < horizon(m, X)` (`resultsCount`).
- Groups (level 0) stop at `closeTime ≤ D(m)`, the stagger's floor.
- A coalition is always one level above every seat it holds (`levelOf`), so for any seat `S` of `X`: `horizon(m, S) ≤ D(m) + (k − 1) × g < horizon(m, X)`. Every lower level stops at least `g` before the level above, as #387 asks. A group seated directly in a level-3 coalition gets `3g` to report, more than it needs, and that's harmless.
- Example vectors with `g = 1,440`: deadline `D`; level 1 `D + 1,440`; level 2 `D + 2,880`; level 3 `D + 4,320`.
- **Genesis horizon** (if Q2 is (a)): for a coalition `X` founded at receipt `r`:

```
formsFinal(X) = r + windows.ordinary.max × 1,440 + level(X) × g
```

`formsBy` is renamed to `formsFinal`, with no decline at it.

### Outcomes and finality at level `k ≥ 1` (`settleMotion`, `coalitionProgress`)

- `expired(m) ⇔ now ≥ horizon(m, X)`.
- **Fail:** final at once, and the motion closes at the deciding result's receipt (unchanged).
- **Pass:** final at `horizon(m, X)`. That's **decision 1**: the minute every seat's own vote has closed, plus `g` for the last one to cross.
- Open until then, reading as a lapse. At the horizon, missing results count as fails (unchanged).
- Everything that waited for `settlesAt(m) = D + 10,080` waits for `horizon(m, X)` instead:
  - the Atoms changing (`applyPasses` via `final`);
  - a coalition Dispatch going out (`advanceMotionDispatches`);
  - an admission (`advanceAdmissions`);
  - a promotion going out (`advancePromotions`, **#323**);
  - the decided day (`history.decidedAt`, `coalitionHome`, `CoalitionProgress` "takes effect on");
  - a carried score's last decision (`store/carry.ts decisions`, **#323**).

### Crossing up: only final outcomes (#387, option B)

- **`motionResult` (a lower coalition's result on `m`):** `own.final ? (pass ? 'pass' : 'fail') : null`, the same as a group's. The "certain pass crosses early" branch goes. So `C`'s pass reaches `D` only at or after `horizon(m, C)`, and must arrive before `horizon(m, D) ≥ horizon(m, C) + g`.
- **`heldOutcome` (a coalition's reconcile motion as its seat above):** final only, as a group's. `genesisResult` follows it.
- **`withdrawnPass` is deleted.** A coalition never crosses a non-final pass, so there's never one to withdraw.
  - A forged `pass` for `C`'s seat above, posted by a holder of `C`'s seat secret, is answered by `C`'s own final result: a fail makes the seat contested, which counts as a fail; a pass agrees with it.
  - `C` no longer answers a forged pass early with a fail. That would make `D`'s outcome depend on when `C`'s devices synced, which is the dependence #387 removes. A forged pass is now handled for a coalition's seat exactly as for a group's: harmless as long as `C`'s own result crosses within `g`.
- **Promotions (#323):**
  - `coalitionRising.passed = proposal.final && outcome.kind === 'pass'`, final instead of certain.
  - `until = decidedAt + g`: a group's at `closeTime(p) + g`, a coalition's at `horizon(m, C) + g`.
  - `promotionsOwed` keeps its `coalition.at < until` check.
- **What crosses doesn't change:** only a pass or fail per motion and seat, posted by a participant bound to the seat.

**Why the cross-level outcome is order- and timing-independent.**
1. A level's outcome at its horizon is a function of its seats' results alone. Each seat counts once (`seatResult`, fail-wins), so arrival order doesn't matter (existing property).
2. Each seat's result is final when it crosses.
3. Any crossing time in `[horizon(seat), horizon(above))` lands while results count.

By induction from the groups up, every level's final outcome is a function of the groups' final outcomes alone. #375's counterexample (`C` of 5 seats, 4 early passes, then a contest) can no longer happen: nothing crosses from `C` before `horizon(m, C)`, and at that minute `C`'s outcome is final.

### Formation (decision 2, plus Q2)

- **Forming → formed:** every founding seat has reported pass on the genesis id (unchanged).
- **Forming → declined:** a founding seat's `fail` is recorded. A device posts one only once its group's reconcile vote has **closed** without a pass (`genesisResult`), so a provisional count never withdraws a coalition. `declinedAt` is that receipt, and relay time stops there (unchanged).
- **Close-out at `formsFinal`** (the founder's answer, built): `expireFormation` stays, at `formsFinal`, with its calls in `advanceTo` and `endTime`, so a coalition still forming then is declined for every founding group, and relay time stops there. Its row reads "Not every group voted in time, so the coalition won't form.". (This plan's first draft deleted it; #539 overrides that.)
- **Genesis results:** with Q2 (a), they count `iff status = forming ∨ received < formsFinal`. So once formed, a founding seat's fail declines it only before `formsFinal`, and from then on its formation is final.
- **Withdrawal is derived, not recorded:** status `declined` comes from the fail in the coalition's log, and every device folds the same log. No new event, and nothing new for the relay.

### Screens

- **Group home's coalition row, forming** (`coalitionLines.ts`). The group's own seat line becomes `{kind: 'waiting', group, notPassing: true}` while the group's reconcile Proposal is open, at least one member has scored it, and its `outcome.kind !== 'pass'` (Q3.2).
  - It reads "Waiting for <group>'s vote · Currently not passing".
  - It's read from the group's own folded Proposal on this device. Other seats' lines can't show it, and never do.
- **Row, declined:** "Didn't form" with "<group> didn't pass this", or, at the close-out, the `lapsed` line, reworded: "Not every group voted in time, so the coalition won't form.".
- **The other group's reconcile Proposal once its coalition is declined:** the ballot is replaced by "<group> didn't pass this, so the coalition won't form." (Q3.1).
- **Motion progress:** "The coalition passed this. It takes effect on <day>" reads its day from the new horizon, as do the Decided list and History.
- Copy goes in `messages.ts`, in DESIGN.md's voice. DESIGN.md gains a Coalitions-row bullet listing the row's states: Forming (with the waiting, currently-not-passing and didn't-pass lines, or waiting for the card), Formed, and Didn't form.

## 3. Files

**Engine**

- `client/src/engine/coalition.ts`:
  - `HORIZON_STEP_MINUTES` replaces `RESULT_GRACE_MINUTES`;
  - `horizonOf(motion)` replaces `settlesAt`;
  - `MotionSeats.level`;
  - `formsFinal` replaces `formsBy`;
  - `resultsEnd` and `resultsCount` are updated;
  - `expireFormation` is deleted;
  - the docstrings are updated.
- `client/src/engine/fold.ts`:
  - `openMotion` and the own-motion snapshot store `level`;
  - `settleMotion`, `advanceMotionDispatches`, `advanceAdmissions` and `advancePromotions` (#323) use the horizon;
  - `heldOutcome` is final-only;
  - `endTime` and `advanceTo` drop `expireFormation`.
- `client/src/engine/crossing.ts`:
  - `motionResult` is final-only;
  - `withdrawnPass` is deleted;
  - `groupRising`, `coalitionRising` and `promotionsOwed` (#323) are updated;
  - the module docstring is updated.
- `client/src/engine/coalitionProgress.ts`: `settles` is the horizon.
- `client/src/engine/history.ts`: `decidedAt`.

**Store**

- `client/src/store/carry.ts`: `decisions` (#323).

**App**

- `client/src/app/coalitionLines.ts`: `notPassing`, `lapsed` dropped, and the declined reconcile Proposal line.
- `client/src/app/CoalitionSection.tsx`.
- `client/src/screens/ProposalView.tsx`: the reconcile ballot, withdrawn once its coalition is declined.
- `client/src/app/messages.ts`.
- `client/src/app/CoalitionProgress.tsx`, if its wording names the week.

**Tests and vectors**

- `client/src/test/coalitions.ts`: the horizon helper.
- `client/src/test/vectors.ts`: the format header documents horizons.
- Vectors re-timed to the horizon: `client/src/engine/vectors/coalition-*.json`, `nested-*.json`, `promote-*.json` and `follow-dispatch.json` (§4).
- The tests listed in §4.

**e2e**

- `client/e2e/coalition.spec.ts` and `client/e2e/promote.spec.ts`: they already read `settles` from the `<time>` and need only their step titles changed from "a week after the deadline". `client/e2e/reconcile.spec.ts` is checked for the `lapsed` line.

**Docs**

- `docs/adr/0036-coalition-each-group-passes.md`: the amendment (§5).
- `docs/adr/README.md`: the 0036 row's "amended by".
- `docs/spec/phase-1/04-events/15-coalitions.md`:
  - Forming, Results that cross, Deciding a motion, Coalition Dispatches, Push, What each group sees, Nesting (motions down, the withdrawn-pass bullet replaced by staggered horizons, golden vectors), Promotion (record and going out);
  - the `coalition` field list (`formsFinal`).
- `docs/spec/phase-1/05-tally.md:29`: "Once expired, at deadline + 10,080".
- `DESIGN.md`: the row states.
- `client/CLAUDE.md`: e2e prose "a week past the pass's deadline" and "a week after its deadline".

## 4. Tests and vectors (TDD: each fails first)

**Unit, written first and failing on main:**

1. `coalition.test.ts`:
   - `horizonOf` is `D + level × g` for levels 1–3;
   - `resultsCount` is true at `horizon − 1` and false at `horizon`, at each level;
   - a forming coalition takes a genesis result after `genesis + 14 days + level × g`, and a formed one doesn't (Q2a).
   - **Fails on main:** the horizon is `D + 10,080` at every level, and `expireFormation` declines.
2. `fold.test.ts` / `coalition.test.ts`:
   - a pass is final at `horizon` and not at `horizon − 1`;
   - Atoms change at `horizon`;
   - a coalition Dispatch goes out at `horizon`;
   - an admission seats at `horizon`.
   - **Fails on main:** each happens at `D + 10,080`.
3. `crossing.test.ts`:
   - a level-1 coalition whose pass is certain but not final owes nothing up (`resultsToReport` returns `[]`), and owes `pass` at its horizon;
   - a crossed forged pass for its seat earns no early `fail` (`withdrawnPass` gone), and the final fail, once it's due, makes the seat contested.
   - **Fails on main:** a certain pass crosses at once, and the withdrawn pass is answered with a fail at once.
4. `crossing.test.ts` / `promotion.test.ts` (**#323**):
   - a coalition's promotion record goes up only once its pass is final, and until `horizon + g`;
   - `advancePromotions` sends at the horizon.
   - **Fails on main:** passed once certain, and sent at `D + 10,080`.
5. `coalitionProgress.test.ts`: `settles` is the horizon at each level, and `final` flips there.
6. `history.test.ts` and `store/carry.test.ts`: decided days at the horizon.
7. `coalitionLines.test.ts`:
   - `notPassing` on the own seat's line while open with a non-pass count and at least one ballot;
   - no line before any ballot;
   - none for another seat;
   - no `lapsed` kind.
8. `CoalitionSection.test.tsx`, plus the reconcile ballot screen's test: the copy, `<bdi>` around group names, and the withdrawn ballot.

**Properties (fast-check, `properties.test.ts`, "properties of nested coalitions"):**

- **New: full order and timing independence across 3 levels at any seat count.**
  - Setup: an arbitrary nest `D ⊃ C ⊃ groups`, with seat counts 2–6 at each coalition level (including ≥5, so two-thirds applies) and arbitrary group outcomes (pass, fail, contest or none).
  - For two arbitrary arrival orders, and for each lower log, two arbitrary crossing minutes inside `[horizon(seat), horizon(above))`, at least one sync after its horizon:
    - `D`'s outcome, finality and Atoms are deep-equal;
    - they equal `coalitionOutcome` applied level by level to the final outcomes.
  - Replaces the #375 property's "never counts a pass C didn't make" with the stronger equality.
- **Fixed examples:** #375's 5-seat counterexample (`withdrawn`: L0's contest after 4 passes), and the recovery case (`recovered`: L4's pass after the contest). Both become `examples:` of the new property, and now give the same `D` outcome whenever `C`'s devices cross.
- The existing "same outcome whatever order distinct seats' results arrive in" and canary properties keep running, with their time arguments moved to the horizon.
- `coalitionDispatch.test.ts`: "a coalition's Dispatch goes out exactly when every seat's pass is final", moved to the horizon.

**Golden vectors** (hand-written JSON, as today, read by `src/test/vectors.ts` and run by `vectors.test.ts`; no generator):

- **New `nested-horizons.json`** (`kind: "nested"`):
  - **Horizon vectors,** one per level: a group, then a level-1, level-2 and level-3 coalition, each with a result received at `horizon − 1` (counted) and one at `horizon` (ignored). `expect` pins each motion's `final`, `outcome` and `closedAt`, plus the `report` owed at `horizon − 1` and `horizon`.
  - **`nested-horizons-five-seats`:** #375's counterexample as a vector. `C` of 5 seats; 4 passes and a contest; `C` reports nothing to `D` before `horizon(m, C)`, then its final outcome.
  - **`nested-horizons-recovery`:** the recovery case: `D` passes.
- **New `coalition-formation.json` entries:**
  - built instead: `coalition-formation.json`'s close-out vectors move to `formsFinal` (a minute before, still forming; at it, declined, and a pass received then ignored), and `nested-horizons.json` adds the close-out at level 2 (`forms-final-level-2*`);
  - a formed coalition's founding-seat fail before `formsFinal` declines it; after, it's ignored (Q2a).
- **Re-timed:** every existing coalition, nested, promote and follow vector whose `relayNow` or receipts sit at `D + 10,080` moves to the horizon.
  - `nested-contest.json` loses its withdrawn-pass vector, replaced by the five-seats vector above, since the rule it pinned is gone.
  - `formsBy` → `formsFinal` in `coalition-formation.json`.
- Seqs stay global, every reference stays symbolic (`@n`, `%name`, `^A`), and nothing random, so the vectors stay reproducible. A sealed seat's nonce is random, as today, and is never pinned.

**Screens:**

- `screens/coalitionLoop.test.tsx`, `nestedLoop.test.tsx` and `promoteLoop.test.tsx` advance their clocks to the horizon.
- New row states are rendered in jsdom tests.
- axe runs on each state in the screenshot scratch spec.

**e2e:** no new spec. `coalition.spec.ts` and `promote.spec.ts` read the day from the UI already, so they follow the horizon. The run goes through gate.sh with `E2E_PROJECTS=chromium`.

**Screenshots:** a scratch spec, not committed, writes to `scratchpad/shots250/`:
- the forming row with "Currently not passing";
- the declined row ("Didn't form");
- the withdrawn reconcile ballot;

each at 390 and 1280 wide, light and dark, deviceScaleFactor 2, with axe on each.

## 5. ADR-0036 amendment outline (dated 2026-11-14, #250 and #387)

**Title:** "Amendment (2026-11-14, #250, #387): A Pass Is Final When Every Group's Vote Has Closed, and Each Level Stops Before the One Above"

1. **Context.**
   - #100 made a pass final at deadline + 7 days, and gave a coalition 21 days to form.
   - #375 found that a lower coalition's early pass made the level above depend on sync timing.
2. **Decision.**
   1. **Finality (#250, option B):** final at `D + level × g`, with `g` per Q1.
   2. **Formation:** no fixed deadline; withdrawn only by a crossed fail, which a device posts only once its group's vote has closed; "currently not passing" on screen before that; and the genesis horizon per Q2.
   3. **Staggered horizons (#387, option B):** each level stops at least `g` before the level above, and only final outcomes cross. `withdrawnPass` (#375's option A) is retired.
   4. **#323:** promotions and coalition Dispatches go out at the new horizon.
3. **Why.**
   - A week's wait was the price of one forged-pass defence. `g` keeps that defence for a group whose participants open Reconcile within `g`.
   - Order and timing independence, by induction on levels.
4. **Options weighed.**
   - **#250 §1:** A (7 days), B (chosen), C (cite a close time: needs proof the coalition can check without reading the group).
   - **#250 §2:** keep `formsBy`, or drop it (chosen).
   - **#387:** (A) withdrawn pass crosses as fail (built in #375, retired), or (B) staggered horizons (chosen).
5. **Consequences.**
   - A coalition of groups is final `g` after its deadline, and 3 levels `3g` after.
   - A group none of whose participants opens Reconcile within `g` of its close counts as not passing.
   - A coalition may stay forming indefinitely (accepted).
   - Forged-pass exposure per Q2.
   - The vectors and properties named.
   - ADR-0057's "deadline + 10,080 minutes during which results count" now reads as the horizon.
6. **Privacy:**
   - nothing new leaves a group's log;
   - no new event or field reaches the relay (`MotionSeats.level` and `formsFinal` are folded state, not records);
   - no new nudge or wake;
   - the coalition graph is no more enumerable;
   - "currently not passing" is read from the group's own ballots on its own members' devices.
7. **README row:** "Amended by 0036's 2026-11-14 amendment (#250, #387)".

## 6. As built (#539)

- **Engine:** `HORIZON_STEP_MINUTES`, `horizonOf`, `motionHorizon` and `MotionSeats.level` in `coalition.ts`; `snapshotMotion` in `fold.ts` keeps each motion's level; `heldOutcome` and `motionResult` are final-only; `withdrawnPass` is gone; `coalitionRising` reads its horizon from the coalition's snapshot.
- **Reminder:** `REMINDER_MINUTES` and `reminds` in `engine/nudges.ts`; `nudgesFor` adds the reminder before a reconcile or motion vote's other two nudges, at the same shift, when it opened before then. `ProposalView`'s `Reminder` shows the words.
- **Screens:** `CoalitionLine`'s `notPassing`, `withdrawnBy` in `coalitionLines.ts`, `Withdrawn` in `ProposalView.tsx`, and `composerDispatchHint(days)`.
- **Vectors:** `nested-horizons.json` (21 vectors, generated once from `nested-three-levels.json` and main's `nested-contest.json`, then committed as plain JSON); the withdrawn-pass vectors leave `nested-contest.json`; every vector timed at `deadline + 10,080` or `formsBy` moves by −8,640 minutes to the level-1 horizon or `formsFinal`; nested and promote vectors that crossed a certain pass early cross at the horizon instead, with a `-not-final` sibling a minute before.
- **Property:** "decides every level of three the same whatever the order and timing of results, at any seat count", in `properties.test.ts`, replaces #375's; reverting the stagger (every level's horizon at `D + g`) fails it at once.
- **Known edge, not handled (ADR-0073):** a seated coalition that admits a higher seat rises a level, but its seat above stays at the level its genesis or admit motion stated. Its motions opened after the rise then share the level above's horizon, so its final result arrives as results stop counting there, and its seat counts as not passing: fail-safe, never a forged pass.
