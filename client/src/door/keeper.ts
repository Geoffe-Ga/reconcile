/**
 * Keeping a group's front door, after each sync of it (#121; ADR-0038,
 * ADR-0040; docs/spec/phase-1-spec.md §4, Opt-ins and §7).
 *
 * No server holds a door's keys, so the members' devices keep its page and
 * read its inbox, acting only on the door's effective value
 * (`effectiveOptIn`): a steward's narrowing closes it at once. After each
 * sync of a group, while this device is a member, no removal of it has
 * passed (#115), and the group isn't leaving:
 *
 * 1. **The page.** While the door is open in effect, the device posts its
 *    page when what it says (the name, the excerpt, the shown count) differs
 *    from the newest copy, or that copy is 7 days old (`page.ts`). Every
 *    other door the group has had, one rotated away, closed, narrowed or
 *    dissolved (#108), gets a closed page, `{v: 1, open: false}`, once, while
 *    its newest copy still says open.
 * 2. **The inbox.** While the door is open in effect, the device of a member
 *    who may invite reads its inbox (`inbox.ts`). Once it's off, no device
 *    reads it.
 *
 * After each complete pass, the device looks for replies to the
 * applications it sent ({@link DoorKeeper.replies}, `apply.ts`).
 *
 * The device remembers in memory which pages it found current, so it reads a
 * page mailbox once a launch, again only when the page changes or its copy
 * comes due. Nothing the keeper does, or fails to do, fails a sync pass.
 */
import { can, isOusted } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { type FrontDoor, isFrontDoor, rulesChangeOf } from '../engine/optIns';
import type { Relay } from '../net/relay';
import type { Seal } from '../crypto/seal';
import type { Store } from '../store/db';
import { foldGroup } from '../store/expiry';
import { checkReplies } from './apply';
import { readInbox } from './inbox';
import {
  type DoorPage,
  encodePage,
  PAGE_VERSION,
  pageFor,
  publishPage,
  REFRESH_MINUTES,
} from './page';

/** What the keeper reaches. */
export interface DoorKeeperOptions {
  readonly store: Pick<Store, 'getGroup' | 'updateInbox' | 'listSent' | 'updateSent' | 'dropSent'>;
  readonly relay: Pick<Relay, 'getBlobs' | 'putBlob'>;
  readonly seal: Seal;
  /** Turns an Atom's Markdown into its words, for the excerpt (`plainText` in the app). */
  readonly plainText: (markdown: string) => string;
  /** The device clock in milliseconds, for replies' 30 days (default: `Date.now`). */
  readonly clock?: () => number;
}

/** The keeper, which the sync loop runs after each group it syncs, and after each complete pass. */
export interface DoorKeeper {
  /** Keeps `groupId`'s door pages and reads its inbox. */
  run(groupId: string): Promise<void>;
  /** Looks for replies to the applications this device sent. */
  replies(): Promise<void>;
}

/** A closed page: every door the group no longer has open shows it. */
export const CLOSED: DoorPage = { v: PAGE_VERSION, open: false };

/** The door open in effect, unless the group has dissolved (#108). */
export function openDoor(state: GroupState): FrontDoor | null {
  if (state.dissolved !== null) return null;
  const door = state.optIns.frontDoor;
  return door === false ? null : door;
}

/**
 * Every door the group has had stand: each passed front door change's door,
 * once by its key, oldest first. The standing door is the last of them.
 */
export function doorsThatStood(state: GroupState): FrontDoor[] {
  const doors = new Map<string, FrontDoor>();
  for (const proposal of state.proposals) {
    const change = rulesChangeOf(proposal);
    const passed = proposal.final && proposal.outcome.kind === 'pass';
    if (change?.optIn === 'frontDoor' && passed && isFrontDoor(change.value)) {
      doors.set(change.value.sign, change.value);
    }
  }
  return [...doors.values()];
}

/** The pages to keep now: the open door's, and a closed one for each other door that stood. */
export function pagesDue(
  state: GroupState,
  plainText: DoorKeeperOptions['plainText'],
): (readonly [FrontDoor, DoorPage])[] {
  const open = openDoor(state);
  const closed = doorsThatStood(state)
    .filter((door) => door.sign !== open?.sign)
    .map((door) => [door, CLOSED] as const);
  return open === null ? closed : [[open, pageFor(state, open, plainText)], ...closed];
}

/** A keeper over `options.store`. */
export function createDoorKeeper(options: DoorKeeperOptions): DoorKeeper {
  const { store, relay, seal, plainText, clock = Date.now } = options;
  /** Each door's page as last found current, and the relay minute it next comes due. */
  const current = new Map<string, { readonly page: string; readonly until: number }>();

  async function keep(door: FrontDoor, page: DoorPage, at: number): Promise<void> {
    const text = new TextDecoder().decode(encodePage(page));
    const held = current.get(door.sign);
    if (held?.page === text && at < held.until) return;
    const outcome = await publishPage({ relay, seal }, door, page, at);
    // A closed page needs posting only once; an open one again once its copy comes due.
    const since = outcome.kind === 'posted' ? at : outcome.received;
    const until = page.open ? since + REFRESH_MINUTES : Infinity;
    current.set(door.sign, { page: text, until });
  }

  return {
    async run(groupId) {
      const group = await store.getGroup(groupId);
      if (group === undefined || group.leaving !== undefined || group.relayNow === null) return;
      // Expired ballots stay expired (#111): the door reads the group as every screen does.
      const state = foldGroup(group);
      const me = group.me.author;
      // From a removal's final pass its member only reads, so their device keeps no door (#115).
      if (state.group === null || !can(state, me, 'read') || isOusted(state, me)) return;
      for (const [door, page] of pagesDue(state, plainText)) await keep(door, page, state.at);
      const open = openDoor(state);
      if (open !== null && can(state, me, 'invite'))
        await readInbox({ relay, store }, groupId, open);
    },
    replies: () => checkReplies({ relay, store, now: clock }),
  };
}
