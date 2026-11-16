/**
 * Discover's feed (#429; ADR-0077 Context and §7): one list, newest first, of
 * every Dispatch this device already holds, from each group the person is in,
 * each coalition they're in and each coalition they follow (#124), with the
 * Dispatches that rose from a member group (#126).
 *
 * A Dispatch that rose keeps its own id at every level (`advancePromotions`
 * in the fold), so the device may hold one Dispatch in a group and in the
 * coalitions above it. The feed shows it once, at the highest level it
 * reached, as that level holds it: its card there names the seat it rose
 * from. Order is by `received`, newest first, then by id, and never by the
 * order the places came in.
 *
 * Nothing here reaches the network: the feed is a view of logs the device
 * already holds, behind the same unlock as Start (spec §8). Pure.
 */
import type { Dispatch } from '../engine/dispatches';
import type { GroupState } from '../engine/fold';
import type { Group } from '../store/db';
import { shownState } from '../store/archive';
import type { HeldCoalition } from '../store/coalitions';

/** What the feed reads of a place's folded log: its name, its Dispatches, and the motions that carried any. */
export interface FeedState {
  readonly name: string;
  readonly dispatches: readonly Dispatch[];
  readonly proposals: readonly {
    readonly id: string;
    readonly target: { readonly kind: string };
  }[];
}

/** A group or coalition the feed shows Dispatches from. */
export interface FeedPlace<S extends FeedState = GroupState> {
  readonly kind: 'group' | 'coalition';
  /** The group's or coalition's id, which its home's route names. */
  readonly id: string;
  /** Its log, folded. */
  readonly state: S;
  /** Whether it is a read-only archive of a group that dissolved (#108). */
  readonly ended: boolean;
}

/** One Dispatch in the feed, and the place it's shown from. */
export interface FeedItem<S extends FeedState = GroupState> {
  readonly dispatch: Dispatch;
  readonly from: FeedPlace<S>;
}

/**
 * How many levels `dispatch` had risen when `state` took it in: 0 for a
 * group's own, the promotion motion's level for one that rose (#126), and 1
 * for a coalition's own Dispatch.
 */
function levelOf(kind: FeedPlace['kind'], state: FeedState, dispatch: Dispatch): number {
  if (kind === 'group') return 0;
  const { by } = dispatch;
  if (typeof by === 'string') return 1;
  const target = state.proposals.find(({ id }) => id === by.proposal)?.target;
  return target !== undefined && 'level' in target && typeof target.level === 'number'
    ? target.level
    : 1;
}

/** A candidate for the feed, with the level its place holds it at. */
interface Candidate<S extends FeedState> {
  readonly item: FeedItem<S>;
  readonly level: number;
}

/** Whether `a` should show in place of `b`: the higher level, then, for a stable pick, the lower place id. */
function outranks<S extends FeedState>(a: Candidate<S>, b: Candidate<S>): boolean {
  if (a.level !== b.level) return a.level > b.level;
  return a.item.from.id < b.item.from.id;
}

/** Newest first, then by id. */
function newestFirst<S extends FeedState>(a: FeedItem<S>, b: FeedItem<S>): number {
  const by = b.dispatch.received - a.dispatch.received;
  if (by !== 0) return by;
  if (a.dispatch.id === b.dispatch.id) return 0;
  return a.dispatch.id < b.dispatch.id ? -1 : 1;
}

/**
 * Every Dispatch `groups` and `coalitions` hold, each once, at the highest
 * level it reached, newest first, then by id.
 */
export function discoverFeed<S extends FeedState>(
  groups: readonly FeedPlace<S>[],
  coalitions: readonly FeedPlace<S>[],
): FeedItem<S>[] {
  const best = new Map<string, Candidate<S>>();
  for (const from of [...groups, ...coalitions]) {
    for (const dispatch of from.state.dispatches) {
      const candidate = {
        item: { dispatch, from },
        level: levelOf(from.kind, from.state, dispatch),
      };
      const held = best.get(dispatch.id);
      if (held === undefined || outranks(candidate, held)) best.set(dispatch.id, candidate);
    }
  }
  return [...best.values()].map(({ item }) => item).sort(newestFirst);
}

/**
 * The place a stored group or coalition entry is in the feed, or null for
 * one it leaves out: one whose genesis isn't back yet, one this device is
 * leaving, and a removed member's read-only copy (#115), since the person is
 * no longer in it. A dissolved group's read-only archive (#108) stays, marked
 * as ended, and so does a restored copy that hasn't heard from its group yet
 * (#231).
 */
export function feedPlaceOf(
  kind: FeedPlace['kind'],
  entry: Group,
  state: GroupState,
): FeedPlace | null {
  if (state.group === null || entry.leaving !== undefined) return null;
  const reason = entry.archived?.reason;
  if (reason === 'removed') return null;
  return { kind, id: entry.groupId, state, ended: reason === 'dissolved' };
}

/** A stored group's place in the feed, folded as the device shows it (`shownState`), or null. */
export function groupPlace(group: Group): FeedPlace | null {
  return feedPlaceOf('group', group, shownState(group));
}

/** A coalition entry's place in the feed, from its folded log (#114, #124), or null. */
export function coalitionPlace({ entry, state }: HeldCoalition): FeedPlace | null {
  return feedPlaceOf('coalition', entry, state);
}
