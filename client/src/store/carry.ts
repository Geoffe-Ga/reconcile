/**
 * Carried scores (#126; ADR-0037, ADR-0065, ADR-0009; spec §4, Coalitions,
 * Promotion): nobody votes twice on the same Dispatch.
 *
 * When a person scores a Dispatch that may rise, in the group it started in
 * or on a promotion motion in another group, this device keeps the score on
 * that group's record ({@link KeptScore}): the Dispatch's id, its ceiling,
 * the score and the ballot's minute, never the note. When a promotion motion
 * for that Dispatch opens in another group on this device where the person is
 * eligible, and they haven't voted there, the device plans to cast the same
 * score under their identity in that group ({@link CarryPlan}): at a relay
 * minute drawn uniformly at random in the rest of the window
 * ({@link scheduleCarried}), so the relay can't line up the two identities
 * by when they vote. It casts at the first settle at or after that minute,
 * before the deadline, with no note, unless the person changed it by voting
 * there themselves or chose Don't cast. A carried 0 is never cast on its own:
 * the ballot asks for a fresh reason, and refuses one the person wrote
 * elsewhere ({@link copiedNote}), since identical words would link them.
 *
 * Everything here stays on the device, on the records of the groups it
 * concerns: only a score per Dispatch id, which the device's own ballots
 * already hold. A score is kept until the Dispatch reaches its ceiling, or
 * for {@link KEEP_DAYS} days after the last decision on it this device has
 * seen. Nothing goes in a backup file or a link, and a group that goes takes
 * its scores and plans with it.
 */
import { base64url } from '../crypto/base64url';
import { drawBelow, type Random } from '../crypto/random';
import { newBallotSalt } from '../crypto/salt';
import { can } from '../engine/capabilities';
import { MAX_LEVEL, RESULT_GRACE_MINUTES } from '../engine/coalition';
import {
  type Ceiling,
  type ParsedEvent,
  parseRecord,
  type PromoteTarget,
  type Score,
  signEvent,
} from '../engine/event';
import { closeTime, type GroupState, type Proposal } from '../engine/fold';
import { isOpenAt } from '../engine/open';
import { DAY_MINUTES } from '../engine/rules';
import { type HeldCoalition, type Holdings, holdings } from './coalitions';
import {
  type Carried,
  type CarryPlan,
  type Group,
  isCoalitionEntry,
  type KeptScore,
  type Store,
} from './db';

export type { Random };

/** How long a score is kept after the last decision on its Dispatch: 30 days. */
export const KEEP_DAYS = 30;

/** A carried score to schedule (#126): which Dispatch, the score, and the minutes left to cast it in. */
export interface CarryWindow {
  readonly dispatchId: string;
  readonly score: Score;
  /** The first relay minute it may be cast at: now, or the motion's receipt if later. */
  readonly from: number;
  /** The motion's deadline, which it must be cast before. */
  readonly deadline: number;
}

/**
 * The relay minute a carried score is cast at (#126; ADR-0037): drawn
 * uniformly from `from` up to, but not including, `deadline`, by
 * `drawBelow` (`crypto/random.ts`).
 *
 * @throws {RangeError} when no minute is left before the deadline.
 */
export function scheduleCarried(carry: CarryWindow, random: Random): { readonly castAt: number } {
  const span = carry.deadline - carry.from;
  if (!Number.isSafeInteger(span) || span < 1) {
    throw new RangeError('No minute is left before the deadline.');
  }
  return { castAt: carry.from + drawBelow(span, random) };
}

/**
 * Punctuation that reads alike, each folded to one form (#378): single
 * quotes and apostrophes, double quotes, dashes and hyphens, and the ellipsis.
 */
const PUNCTUATION_FOLDS: readonly (readonly [RegExp, string])[] = [
  [/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/gu, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/gu, '"'],
  [/[\u2010-\u2015\u2212]/gu, '-'],
  [/\u2026/gu, '...'],
];

/**
 * A note as {@link copiedNote} compares it: with no zero-width or other
 * format character (`\p{Cf}`, #378), in NFKC, so a full-width or other
 * compatibility form reads as its plain one, its punctuation folded
 * ({@link PUNCTUATION_FOLDS}), trimmed, its spaces run together, in lower case.
 */
function comparable(note: string): string {
  const folded = PUNCTUATION_FOLDS.reduce(
    (text, [from, to]) => text.replace(from, to),
    note.replace(/\p{Cf}/gu, '').normalize('NFKC'),
  );
  return folded.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * Whether `note` is one the person wrote elsewhere (#126; ADR-0065): the
 * same words as any of `elsewhere`, whatever the spacing, case, Unicode form,
 * zero-width characters or quote and dash styles (#378). A carried ballot
 * never copies a note, and the ballot refuses a reason typed out again, which
 * would link the two identities.
 */
export function copiedNote(note: string, elsewhere: readonly string[]): boolean {
  const mine = comparable(note);
  return mine !== '' && elsewhere.some((other) => comparable(other) === mine);
}

/**
 * The promotion record behind a group's Proposal (#126): the target of the
 * coalition motion it opens, when that motion is a promotion, else null.
 */
export function promotionFor(
  proposal: Pick<Proposal, 'id' | 'target'>,
  coalitions: readonly HeldCoalition[],
): PromoteTarget | null {
  const { target } = proposal;
  if (target.kind !== 'motion') return null;
  const top = target.chain.at(-1) ?? target.coalition;
  const coalition = coalitions.find(({ state }) => state.group === top)?.state;
  const motion = coalition?.proposals.find((p) => p.id === proposal.id);
  return motion?.target.kind === 'promote' ? motion.target : null;
}

/**
 * The Dispatch a group's Proposal decides, with its ceiling: its own, put to
 * the group's vote, or a promotion motion's; null for any other Proposal.
 */
export function dispatchOf(
  proposal: Pick<Proposal, 'id' | 'target'>,
  coalitions: readonly HeldCoalition[],
): { readonly id: string; readonly ceiling: Ceiling } | null {
  const { target } = proposal;
  if (target.kind === 'dispatch') return { id: proposal.id, ceiling: target.ceiling };
  const promoted = promotionFor(proposal, coalitions);
  return promoted === null ? null : { id: promoted.dispatch.id, ceiling: promoted.ceiling };
}

/** A group on this device, folded with the motions its seats decide. */
interface Held {
  readonly group: Group;
  readonly state: GroupState;
}

/** The scores `held`'s member gave Dispatches that may rise, as their ballots in its log say. */
function ballotScores(held: Held, coalitions: readonly HeldCoalition[]): KeptScore[] {
  const me = held.group.me.author;
  return held.state.proposals.flatMap((proposal) => {
    const about = dispatchOf(proposal, coalitions);
    const ballot = proposal.ballots.find((b) => b.voter === me);
    const score = ballot?.scores[proposal.id];
    if (about === null || ballot === undefined || score === undefined) return [];
    return [
      { dispatch: about.id, score, ceiling: about.ceiling, at: ballot.received, until: null },
    ];
  });
}

/** What the scores' upkeep reads: every group on the device, and every coalition. */
interface Holding {
  readonly groups: readonly Held[];
  readonly coalitions: readonly HeldCoalition[];
}

/**
 * The relay minute of each final decision on the Dispatch `id` in a log on
 * this device: a group's at its close, a coalition's once final, a fail at
 * once and a pass once results on it stop counting.
 */
function decisions(id: string, { groups, coalitions }: Holding): number[] {
  const inGroups = groups.flatMap(({ state }) =>
    state.proposals
      .filter((p) => p.final && dispatchOf(p, coalitions)?.id === id)
      .map((p) => closeTime(p)),
  );
  const inCoalitions = coalitions.flatMap(({ state }) =>
    state.proposals
      .filter((p) => p.final && p.target.kind === 'promote' && p.target.dispatch.id === id)
      .map((p) => p.closedAt ?? p.deadline + RESULT_GRACE_MINUTES),
  );
  return [...inGroups, ...inCoalitions];
}

/**
 * Whether the Dispatch `id` has reached its ceiling: a coalition on this
 * device has decided it, finally, at its ceiling's level, or at level 3,
 * above which nothing rises.
 */
function reachedCeiling(id: string, coalitions: readonly HeldCoalition[]): boolean {
  return coalitions.some(({ state }) =>
    state.proposals.some(({ final, target }) => {
      if (!final || target.kind !== 'promote' || target.dispatch.id !== id) return false;
      const { level, ceiling } = target;
      return level >= MAX_LEVEL || (ceiling !== 'coalitions' && level >= ceiling);
    }),
  );
}

/** The later of `kept` and {@link KEEP_DAYS} days after the last of `decided`, null with neither. */
function keptUntil(kept: number | null, decided: readonly number[]): number | null {
  const last = decided.length === 0 ? null : Math.max(...decided) + KEEP_DAYS * DAY_MINUTES;
  if (kept === null || last === null) return kept ?? last;
  return Math.max(kept, last);
}

/** The latest of `scores` by its ballot's minute, the last given winning a tie; undefined for none. */
function latest(scores: readonly KeptScore[]): KeptScore | undefined {
  return scores.reduce<KeptScore | undefined>(
    (best, score) => (best === undefined || score.at >= best.at ? score : best),
    undefined,
  );
}

/**
 * `held`'s scores after this settle: those kept, updated by the ballots in
 * its log, each kept until {@link KEEP_DAYS} days after the last decision
 * on its Dispatch, and dropped once that has passed or the Dispatch has
 * reached its ceiling.
 */
function keptScores(held: Held, holding: Holding): KeptScore[] {
  const all = [...(held.group.scores ?? []), ...ballotScores(held, holding.coalitions)];
  const now = held.group.relayNow;
  return [...new Set(all.map((score) => score.dispatch))].flatMap((id) => {
    const found = latest(all.filter((score) => score.dispatch === id));
    if (found === undefined || reachedCeiling(id, holding.coalitions)) return [];
    const until = keptUntil(found.until, decisions(id, holding));
    if (now !== null && until !== null && now >= until) return [];
    return [{ ...found, until }];
  });
}

/** The events a record list carries, skipping any that doesn't verify. */
function parsedOf(records: readonly Uint8Array[]): ParsedEvent[] {
  return records.flatMap((bytes) => {
    const parsed = parseRecord(bytes);
    return parsed === null ? [] : [parsed];
  });
}

/** Whether `held`'s member has voted on `proposal`, in the log or waiting in the outbox. */
function hasVoted(held: Held, proposal: Proposal, pending: readonly ParsedEvent[]): boolean {
  const me = held.group.me.author;
  if (proposal.ballots.some((ballot) => ballot.voter === me)) return true;
  return pending.some(({ event }) => event.type === 'vote' && event.body.proposal === proposal.id);
}

/** Whether `proposal` still takes ballots at relay minute `now`. */
function openAt(proposal: Proposal, now: number): boolean {
  return !proposal.final && isOpenAt(proposal, now);
}

/** What planning reads besides the group: the coalitions, every kept score, the random source and now. */
interface Planning {
  readonly coalitions: readonly HeldCoalition[];
  readonly scores: readonly KeptScore[];
  readonly random: Random;
  readonly now: number;
  readonly pending: readonly ParsedEvent[];
}

/**
 * Whether `plan` still stands: its motion is still open, before its deadline,
 * which is the plan's, and the member hasn't voted.
 */
function stands(plan: CarryPlan, held: Held, planning: Planning): boolean {
  const proposal = held.state.proposals.find((p) => p.id === plan.motion);
  if (proposal === undefined || !openAt(proposal, planning.now)) return false;
  return !hasVoted(held, proposal, planning.pending);
}

/**
 * A new plan for `proposal`, when it is an open promotion motion this
 * member is eligible on and hasn't voted on, and the device holds their
 * score for its Dispatch from any group; its minute drawn now.
 */
function newPlan(held: Held, proposal: Proposal, planning: Planning): CarryPlan[] {
  const promoted = promotionFor(proposal, planning.coalitions);
  if (promoted === null || !openAt(proposal, planning.now)) return [];
  const eligible = proposal.eligible.includes(held.group.me.author);
  if (!eligible || hasVoted(held, proposal, planning.pending)) return [];
  const dispatchId = promoted.dispatch.id;
  const score = latest(planning.scores.filter((kept) => kept.dispatch === dispatchId))?.score;
  if (score === undefined) return [];
  const { deadline } = proposal;
  const from = Math.max(planning.now, proposal.received);
  const { castAt } = scheduleCarried({ dispatchId, score, from, deadline }, planning.random);
  return [{ motion: proposal.id, dispatch: dispatchId, score, castAt, deadline }];
}

/** `held`'s plans after this settle: those that still stand, then a new one for each motion that needs one. */
function plansFor(held: Held, planning: Planning): CarryPlan[] {
  const kept = (held.group.carries ?? []).filter((plan) => stands(plan, held, planning));
  const fresh = held.state.proposals
    .filter((proposal) => !kept.some((plan) => plan.motion === proposal.id))
    .flatMap((proposal) => newPlan(held, proposal, planning));
  return [...kept, ...fresh];
}

/** Whether `plan` is cast now: not kept back, not a 0, and its minute has come. */
function isDue(plan: CarryPlan, now: number): boolean {
  return plan.skipped !== true && plan.score !== 0 && plan.castAt <= now;
}

/**
 * Whether `held`'s member may vote there now, as the fold checks every
 * ballot: not while a suspension narrows them to reading (#102), nor once a
 * removal of them has passed (#115). Until then their plans wait.
 */
function mayCast(held: Held): boolean {
  return can(held.state, held.group.me.author, 'vote');
}

/** The carried ballot for `plan`: its score alone, with fresh salt and no note, signed by `held`'s member. */
function carriedBallot(held: Held, plan: CarryPlan, ts: number): Uint8Array {
  const body = {
    proposal: plan.motion,
    scores: { [plan.motion]: plan.score },
    salt: base64url(newBallotSalt()),
  };
  const group = held.state.group ?? '';
  return signEvent(held.group.signingKey, { type: 'vote', group, ts, body }).record;
}

/**
 * Saves `held`'s scores and plans when they changed, keeping any plan the
 * person chose Don't cast for meanwhile.
 */
async function keep(store: Store, held: Held, next: Carried): Promise<void> {
  const before = { scores: held.group.scores ?? [], carries: held.group.carries ?? [] };
  if (JSON.stringify(before) === JSON.stringify(next)) return;
  await store.updateCarried(held.group.groupId, (now) => ({
    scores: next.scores,
    carries: next.carries.map((plan) =>
      now.carries.some((p) => p.motion === plan.motion && p.skipped === true)
        ? { ...plan, skipped: true }
        : plan,
    ),
  }));
}

/** What {@link settleCarries} draws minutes with, and the device clock for each ballot's `ts`. */
export interface CarryOptions {
  readonly random: Random;
  readonly clock: () => number;
}

/**
 * After a pass (#126): for each group on the device, keeps the scores its
 * member gave Dispatches that may rise, plans a carried score for each new
 * promotion motion they're eligible on, and casts each plan whose minute has
 * come, before its deadline. Returns the ids of the groups it queued a ballot
 * in, for the loop to send at once. `held` is what `holdings` read.
 */
export async function settleCarries(
  store: Store,
  held: Holdings,
  options: CarryOptions,
): Promise<string[]> {
  const { coalitions } = held;
  if (coalitions.length === 0) return [];
  const groups = held.logs.filter(({ group }) => !isCoalitionEntry(group));
  const holding = { groups, coalitions };
  const kept = groups.map((each) => keptScores(each, holding));
  const scores = kept.flat();
  const queued: string[] = [];
  for (const [i, each] of groups.entries()) {
    const now = each.group.relayNow;
    const pending = parsedOf(each.group.outbox);
    const planning = { coalitions, scores, random: options.random, now: now ?? 0, pending };
    const plans = now === null ? (each.group.carries ?? []) : plansFor(each, planning);
    const due = now === null || !mayCast(each) ? [] : plans.filter((plan) => isDue(plan, now));
    if (due.length > 0) {
      const ts = options.clock();
      await store.enqueueAll(
        each.group.groupId,
        due.map((plan) => carriedBallot(each, plan, ts)),
      );
      queued.push(each.group.groupId);
    }
    const carries = plans.filter((plan) => !due.includes(plan));
    await keep(store, each, { scores: kept[i] ?? [], carries });
  }
  return queued;
}

/** Keeps a carried score from being cast in `groupId` on `motion`: the person chose Don't cast (#126). */
export async function skipCarry(store: Store, groupId: string, motion: string): Promise<void> {
  await store.updateCarried(groupId, (held) => ({
    scores: held.scores,
    carries: held.carries.map((plan) =>
      plan.motion === motion ? { ...plan, skipped: true as const } : plan,
    ),
  }));
}

/**
 * The notes this person wrote on the Dispatch `dispatch` in their groups
 * on this device other than `groupId` (#126), as their ballots there still
 * hold them, so the ballot can refuse a copy ({@link copiedNote}). They never
 * leave the device.
 */
export async function notesElsewhere(
  store: Pick<Store, 'listCoalitions' | 'listGroups'>,
  groupId: string,
  dispatch: string,
): Promise<string[]> {
  const held = await holdings(store);
  return held.logs
    .filter(({ group }) => !isCoalitionEntry(group) && group.groupId !== groupId)
    .flatMap(({ group, state }) =>
      state.proposals
        .filter((proposal) => dispatchOf(proposal, held.coalitions)?.id === dispatch)
        .flatMap((proposal) => {
          const note = proposal.ballots.find((b) => b.voter === group.me.author)?.note ?? null;
          return note === null ? [] : [note];
        }),
    );
}
