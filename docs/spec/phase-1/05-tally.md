## 5. Tally

`tally({eligible, versions: [{id, scores}], bar})` returns `pass` with the winning version, `fail` or `lapse`, each carrying the `bar` it was tallied at (#63, #94). The bar is the Proposal's class's, `rules.bars[class]` (§4). It uses integers only: no floats, division or rounding. For each version, `n` is its number of scorers, `sum` their total, and `zeros` the number of 0s.

1. **Quorum** (ADR-0073, `rules.quorum`). A version is at quorum when `n ≥ 1`, `n ≥ min(eligible, 3)` and `100·n ≥ 30·eligible`. That equals min(eligible, max(3, ⌈0.3 × eligible⌉)) scorers. Each version needs its own quorum, at every bar.
2. **Pass.** A version at quorum passes its bar `{avgAtLeast, zerosUnderPercent}` when `sum ≥ avgAtLeast·n` and `100·zeros < zerosUnderPercent·n`:
   - the ordinary bar, the consent floor (ADR-0002), is `{2, 10}`: `sum ≥ 2·n` and `10·zeros < n`;
   - the entrenched bar (ADR-0015 §2) is `{3, 5}`: `sum ≥ 3·n` and `20·zeros < n`;
   - removal's bar (ADR-0075 §3, #115) is `{3, 5, zerosAllowed: 1}`: `sum ≥ 3·n` and either `zeros ≤ 1` or `20·zeros < n`. A bar that names `zerosAllowed` lets that many zeros through whatever their share; no other bar names it, so a single 0 never blocks a removal and the entrenched bar is unchanged.
3. **Winner** (ADR-0004). Among passing versions, the higher average wins (compare `sumA·nB` with `sumB·nA`), then fewer zeros, then the earlier version.
4. **Outcome.** If no version is at quorum, the vote lapses. If some are at quorum and none passes, it fails.

The vectors in `client/src/engine/vectors/` pin the edges:

- an average of exactly 2.0 passes, and exactly 10% zeros fails;
- a 2-member group passes with 2 of 2 ballots;
- at 11 eligible, 3 scorers lapse and 4 meet quorum; at 15 eligible, 4 lapse and 5 meet it;
- a three-way tie goes to the earliest version;
- a late version that only 2 of 10 eligible members score can't win, because it never reaches quorum (#72);
- at the entrenched bar (#94, `bars-entrenched-edges.json`), an average of exactly 3.0 passes and 2.95 fails; one 0 among 20 scorers (exactly 5%) fails and one among 21 passes; an average of exactly 2.5 with no zeros fails, and passes the ordinary bar (`bars-ordinary-pairs.json`); a vote below quorum lapses; and a version under 5% zeros beats a higher average with more;
- at removal's bar (#115, `bars-removal-edges.json`), an average of exactly 3.0 passes and 2.99 fails; one 0 among 10 scorers passes and two fail; 20 scorers with one 0 pass, which the entrenched bar a dissolve uses still fails; two 0s among 40 (exactly 5%) fail and among 41 pass; and an average of exactly 2.5 with no zeros fails.

Every ballot set that passes the entrenched bar passes the ordinary one and removal's, no outcome depends on the order ballots arrive in, and one 0 never fails removal's zeros line (`properties.test.ts`).

A lapse reads "Not enough people weighed in. This isn't a no." ([ADR-0069](../../adr/0069-lapses-celebration-relational-pilot.md)), and Propose again starts a fresh Proposal with a fresh window (#74).

**What the screens read** (#74). `tallyDetail(input)` (`client/src/engine/tally.ts`) returns `{bar, versions, outcome}`, and `tally(input)` is its `outcome`, so the two can't disagree. Each version carries `{id, scorers, sum, zeros, quorum}` and the flags `atQuorum` (`scorers ≥ quorum`), `averageMet` (`sum ≥ avgAtLeast·scorers`), `zerosMet` (`100·zeros < zerosUnderPercent·scorers`) and `passes` (all three), at the input's bar. The average and zero flags are false until someone has scored, and `quorum` is the count above, at least 1, found without dividing. `proposalTally(proposal)` (`fold.ts`) tallies a folded Proposal's ballots at the bar its outcome carries, the one its class set, as the fold settles every outcome. The consent meter and the result read only these, so they draw each Proposal's own lines and `src/app` holds no threshold numbers. `client/src/app/format.ts` turns them into words in whole-number arithmetic: an average floors to one decimal, a share of zeros floors to a whole percent, and a shortfall rounds up and is never "0.0", so an exact average of 1.96 reads "1.9 · Short by 0.1" against the consent floor, never the line itself.

**Coalition motions** (#100, ADR-0036). A coalition never tallies ballots: each member group tallies its own, at the motion's bar, and `coalitionOutcome({seats, passes, fails, expired})` (`client/src/engine/coalition.ts`) decides over N snapshot seats, in integers. Up to 4 seats it passes when all pass and fails at the first fail. From 5 it passes once `3·passes ≥ 2·N` and fails once `3·(N − fails) < 2·N`. Once expired, at its horizon, deadline + 1,440 minutes per level (#387, ADR-0036's 2026-11-14 amendment), every missing result counts as a fail. A fail wins if the counts ever say both, which distinct seats never do. So at 4 seats 3 passes and a fail fail; at 5, 4 passes pass before the fifth reports and 2 fails fail; at 6, exactly 4 passes pass (`vectors/coalition-thresholds.json`).

**Ranking** (#107). `rank(input)` (`client/src/engine/tally.ts`) returns the versions that pass, at quorum and at the bar, best first: the higher average (`sumA·nB` against `sumB·nA`), then fewer zeros, then the earlier version. `tallyDetail` carries it as `ranking`, and a pass's winner is always `ranking[0]`, so `rank()` and `tally()` can't disagree (`properties.test.ts`). A priority vote shows its options in this order.

---
