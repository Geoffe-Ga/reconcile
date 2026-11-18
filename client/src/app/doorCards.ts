/**
 * Reconcile cards through a front door (#426; ADR-0077 §5, ADR-0074,
 * ADR-0040), apart from any screen.
 *
 * A person in a group, on another group's open door, proposes reconciling
 * with it: {@link makeDoorCard} does what Reconcile with another group does
 * (`makeCard`: their group's reconcile Proposal is queued, and the card
 * posted to its own mailbox for a day), then leaves the card's seed in the
 * door's inbox (`door/card.ts`). Coalitions still form only group to group,
 * by both groups' votes (ADR-0074): the door is only where the card arrives.
 *
 * On the door's side, a member who may propose brings the card to a vote
 * ({@link bringDoorCard}, Bring a card's own `bringCard` for this group) or
 * dismisses it ({@link closeDoorCard}); either records `door-card-closed`,
 * so every member's device stops showing it after its next sync. Nothing
 * here sends anything readable: events go sealed through the outbox, the
 * card through its envelope, and its seed sealed to the door's key. Once
 * the card is at the door, the device notes the door's address and the time
 * in its own store, in no group, backup or link, for 30 days (#491), so it
 * can tell its reader if the steward removes that group from the shelf
 * (`shelf/affected.ts`).
 */
import { parseRecord, signEvent } from '../engine/event';
import { can } from '../engine/capabilities';
import { mayCloseCard } from '../engine/frontDoor';
import { leaveCard } from '../door/card';
import { doorsThatStood } from '../door/keeper';
import { addressOf, type OpenPage } from '../door/page';
import { base64url } from '../crypto/base64url';
import type { Group } from '../store/db';
import { foldGroup } from '../store/expiry';
import type { Services } from './actions';
import {
  bringCard,
  type CardGroup,
  type CardValues,
  type FoundCard,
  makeCard,
  postCardSeed,
} from './reconcile';

/** The door a card goes to: its address, and its page as the person read it. */
export interface DoorTarget {
  readonly address: Uint8Array;
  readonly page: OpenPage;
}

/** A card made at a door, with its post still to run, or why it wasn't made. */
export type DoorCardResult =
  | {
      readonly outcome: 'queued';
      /** The group's reconcile Proposal. */
      readonly proposalId: string;
      /** Posts the card and leaves its seed at the door; rejects when the relay can't be reached. */
      readonly post: () => Promise<void>;
    }
  | { readonly outcome: 'too-large' };

/** Whether any front door `group` has had stand is the one at `address`: the group's own door. */
function ownsDoor(state: ReturnType<typeof foldGroup>, address: string): boolean {
  return doorsThatStood(state).some((door) => base64url(addressOf(door)) === address);
}

/**
 * The groups on this device that may propose reconciling with the group
 * behind the door at `address`: ones it is in, not leaving or read-only,
 * where this member can propose, and never the door's own group. A coalition
 * has no front door, so only groups are offered.
 */
export async function cardGroupsAt(services: Services, address: Uint8Array): Promise<CardGroup[]> {
  const door = base64url(address);
  const groups = await services.store.listGroups();
  return groups.flatMap((group) => {
    if (group.archived !== undefined || group.leaving !== undefined) return [];
    const state = foldGroup(group);
    if (state.group === null || !can(state, group.me.author, 'propose')) return [];
    if (ownsDoor(state, door)) return [];
    return [{ groupId: group.groupId, name: state.name, kind: 'group' as const }];
  });
}

/**
 * Propose reconciling with this group's Submit (#426): `makeCard` for
 * `groupId`, then a post that sends the card and leaves its seed in `door`'s
 * inbox, which only the door's members open, and notes the door on this
 * device (#491). A Proposal too large to send is refused before anything is
 * kept.
 *
 * @throws {Error} when the device isn't in the group.
 */
export async function makeDoorCard(
  services: Services,
  groupId: string,
  values: CardValues,
  door: DoorTarget,
): Promise<DoorCardResult> {
  const made = await makeCard(services, groupId, values);
  if (made.outcome === 'too-large') return made;
  const post = async () => {
    const seed = await postCardSeed(services, made.card);
    await leaveCard(services, door.address, door.page, seed);
    // Only this device keeps where it left the card, so it can tell its
    // reader if the shelf's steward removes that group (#491).
    await services.store.noteSentCard({ door: base64url(door.address), sentAt: services.now() });
  };
  return { outcome: 'queued', proposalId: made.proposalId, post };
}

/**
 * The cards whose `door-card-closed` waits in `group`'s outbox (#426): this
 * device has closed them, though the relay hasn't taken it yet, so they show
 * no more here and none is closed twice.
 */
export function queuedClosings(group: Pick<Group, 'outbox'>): string[] {
  return group.outbox.flatMap((bytes) => {
    const event = parseRecord(bytes)?.event;
    return event?.type === 'door-card-closed' ? [event.body.card] : [];
  });
}

/**
 * Closes the card `card` at `groupId`'s door for every member (#426):
 * queues `door-card-closed` while this member may (`mayCloseCard`), and
 * syncs. `missing` when the group or the right to close it is gone, or it's
 * closed already, or waits to be.
 */
export async function closeDoorCard(
  services: Services,
  groupId: string,
  card: string,
): Promise<'closed' | 'missing'> {
  const group = await services.store.getGroup(groupId);
  if (group === undefined || queuedClosings(group).includes(card)) return 'missing';
  if (!mayCloseCard(foldGroup(group), group.me.author, card)) return 'missing';
  const { record } = signEvent(group.signingKey, {
    type: 'door-card-closed',
    group: groupId,
    ts: services.now(),
    body: { card },
  });
  await services.store.enqueue(groupId, record);
  void services.sync.syncOnce();
  return 'closed';
}

/**
 * Bring it to a vote (#426): Bring a card's own `bringCard` of `found` for
 * `groupId`, under `yourName` in the coalition, then closes the card at the
 * door, so no member brings it twice. Returns the reconcile Proposal's id.
 *
 * @throws {Error} when the device isn't in the group, or a record is too large.
 */
export async function bringDoorCard(
  services: Services,
  groupId: string,
  card: string,
  found: FoundCard,
  yourName: string,
): Promise<string> {
  const proposalId = await bringCard(services, found, groupId, yourName);
  await closeDoorCard(services, groupId, card);
  return proposalId;
}
