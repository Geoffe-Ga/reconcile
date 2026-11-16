/**
 * The front door's inbox, on a member's device (#121; ADR-0038, ADR-0014).
 *
 * While the group's door is open in effect, the device of each member who
 * may invite reads the door's inbox after each sync ({@link readInbox}),
 * opens each application with the door's `box` secret from the group's
 * sealed log, and keeps the ones that parse on the group's record, on this
 * device only. Group home lists them under Applications.
 *
 * 'Send an invite' ({@link sendInvite}) makes an ordinary invite (#73), seals
 * its link to the applicant's reply key, padded, and PUTs it to the reply
 * mailbox their seed derives for 2 days, then queues `door-invited`, naming
 * the application by the SHA-256 of its sealed blob, so everyone sees
 * "Invited by <name>" (engine/frontDoor.ts). Nothing about the applicant
 * enters the group's log but that id.
 *
 * An application's copy of personal Documents (#425) goes once it's
 * answered: the device that sends the invite deletes it as the invite goes,
 * and every other device once it folds the `door-invited`
 * ({@link forgetAnswered}), whether its door is still open or not, and one
 * that reads the application only afterwards never keeps it.
 */
import { fromBase64url } from '../crypto/base64url';
import {
  APPLICATION_INFO,
  applicationIdOf,
  doorChannelsOf,
  openPadded,
  REPLY_INFO,
  replyMailboxOf,
  sealPadded,
} from '../crypto/door';
import { signEvent } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { cardClosedFor, inviteFor, mayRecordInvite } from '../engine/frontDoor';
import type { FrontDoor } from '../engine/optIns';
import type { Relay, RelayPage } from '../net/relay';
import {
  type DoorInbox,
  heldWithoutCopies,
  holdsCopies,
  type ReceivedApplication,
  type ReceivedCard,
  withApplications,
  withCards,
  withoutCardSeeds,
  withoutCopies,
} from '../store/applications';
import type { Store } from '../store/db';
import { foldGroup } from '../store/expiry';
import { parseApplication } from './apply';
import { cardGoneAt, cardsIn } from './card';
import { addressOf } from './page';

/** How long the relay keeps a reply: 2 days, as the invite it carries lasts 1 to 2 (#73). */
export const REPLY_TTL_DAYS = 2;

/** What reading the inbox reaches. */
export interface InboxServices {
  readonly relay: Pick<Relay, 'getBlobs'>;
  readonly store: Pick<Store, 'getGroup' | 'updateInbox'>;
}

/** What 'Send an invite' reaches, and the invite it sends. */
export interface InviteServices {
  readonly relay: Pick<Relay, 'putBlob'>;
  readonly store: Pick<Store, 'getGroup' | 'enqueue' | 'updateInbox'>;
  /** The sync loop, run once after the `door-invited` is queued. */
  readonly sync: { readonly syncOnce: () => Promise<boolean> };
  /** The device clock in milliseconds: the event's display-only `ts`. */
  readonly now: () => number;
  /** Copy invite link's work (#73): posts a fresh invite and resolves to its link. */
  readonly makeInvite: () => Promise<string>;
}

/** An inbox with nothing read yet. */
function fresh(inbox: string): DoorInbox {
  return { inbox, cursor: 0, instance: null, applications: [] };
}

/** The applications among `page`'s records that open under the door's box secret and parse. */
function applicationsIn(
  page: RelayPage,
  inbox: string,
  boxSecret: Uint8Array,
): ReceivedApplication[] {
  return page.records.flatMap(({ seq, received, data }) => {
    const plaintext = openPadded(boxSecret, data, APPLICATION_INFO, inbox);
    const application = plaintext === null ? null : parseApplication(plaintext);
    return application === null
      ? []
      : [{ id: applicationIdOf(data), seq, received, ...application }];
  });
}

/** What tidying the inbox reads of the group: its invites, its closed cards and its relay minute. */
export type DoorDone = Pick<GroupState, 'doorInvites' | 'doorCardsClosed' | 'at'>;

/** Whether an invite has folded for application `id` in `state`: it's answered. */
function answeredIn(state: DoorDone): (id: string) => boolean {
  return (id) => inviteFor(state, id) !== undefined;
}

/**
 * Whether a card is done with in `state` (#426): a member closed it, or the
 * relay has surely dropped it by the group's relay minute.
 */
function cardDoneIn(state: DoorDone): (card: ReceivedCard) => boolean {
  return (card) =>
    cardClosedFor(state, card.id) !== undefined || state.at >= cardGoneAt(card.received);
}

/** `inbox` without what `state` says is done with: answered copies and spent cards' seeds. */
function tidied(inbox: DoorInbox, state: DoorDone): DoorInbox {
  return withoutCardSeeds(withoutCopies(inbox, answeredIn(state)), cardDoneIn(state));
}

/**
 * Reads the door's inbox after the cursor this device holds for it, and
 * keeps each new application. A door whose inbox differs from the one held,
 * after a rotation, starts afresh; a relay instance the device hasn't seen is
 * read again from the start, and applications and cards already held stay,
 * once each. Each application `state` holds an invite for keeps no copy of
 * Documents (#425), and each card it closed or the relay dropped no seed
 * (#426).
 *
 * @throws {Error} when the relay can't be reached or answers wrongly.
 */
export async function readInbox(
  services: InboxServices,
  groupId: string,
  door: FrontDoor,
  state: DoorDone,
): Promise<void> {
  const { inbox } = doorChannelsOf(addressOf(door));
  const held = (await services.store.getGroup(groupId))?.door;
  const start = held?.inbox === inbox ? held : fresh(inbox);
  let page = await services.relay.getBlobs(inbox, start.cursor);
  if (start.instance !== null && page.instance !== start.instance) {
    page = await services.relay.getBlobs(inbox, 0);
  }
  const boxSecret = fromBase64url(door.box);
  const found = applicationsIn(page, inbox, boxSecret);
  const cards = cardsIn(page, inbox, boxSecret);
  const cursor = page.records.at(-1)?.seq ?? start.cursor;
  await services.store.updateInbox(groupId, (current) => {
    const base = current?.inbox === inbox ? current : fresh(inbox);
    const read = withApplications({ ...base, cursor, instance: page.instance }, found);
    return tidied(withCards(read, cards), state);
  });
}

/** Whether `held` keeps anything `state` says is done with: an answered copy or a spent card's seed. */
function holdsDone(held: DoorInbox | undefined, state: DoorDone): boolean {
  const spent = cardDoneIn(state);
  const seeds = (held?.cards ?? []).some((card) => card.seed !== undefined && spent(card));
  return seeds || holdsCopies(held, answeredIn(state));
}

/**
 * Deletes the copy of Documents from each application `state` holds an
 * invite for (#425), and the seed of each card it closed or the relay
 * dropped (#426), with no request, writing nothing when there's none.
 * `held` is the inbox the device holds for `groupId`.
 */
export async function forgetAnswered(
  store: Pick<Store, 'updateInbox'>,
  groupId: string,
  held: DoorInbox | undefined,
  state: DoorDone,
): Promise<void> {
  if (!holdsDone(held, state)) return;
  await store.updateInbox(groupId, (current) =>
    current === undefined ? current : tidied(current, state),
  );
}

/**
 * 'Send an invite' for application `id` of group `groupId`: only while this
 * member may record it (`mayRecordInvite`). Makes an invite, seals its link to
 * the applicant's reply key and PUTs it to their reply mailbox for 2 days,
 * then queues `door-invited` and deletes the application's copy of Documents
 * from this device (#425). `missing` when the application or the right to
 * answer it is gone; `failed`, with nothing queued and the copy kept, when
 * the relay can't be reached.
 */
export async function sendInvite(
  services: InviteServices,
  groupId: string,
  id: string,
): Promise<'sent' | 'failed' | 'missing'> {
  const group = await services.store.getGroup(groupId);
  const application = group?.door?.applications.find((held) => held.id === id);
  if (group === undefined || application === undefined) return 'missing';
  if (!mayRecordInvite(foldGroup(group), group.me.author, id)) return 'missing';
  try {
    const link = await services.makeInvite();
    const mailbox = replyMailboxOf(fromBase64url(application.reply.seed));
    const key = fromBase64url(application.reply.key);
    const blob = sealPadded(key, new TextEncoder().encode(link), REPLY_INFO, mailbox);
    await services.relay.putBlob(mailbox, blob, REPLY_TTL_DAYS);
  } catch {
    return 'failed';
  }
  const { record } = signEvent(group.signingKey, {
    type: 'door-invited',
    group: groupId,
    ts: services.now(),
    body: { application: id },
  });
  await services.store.enqueue(groupId, record);
  await services.store.updateInbox(groupId, (held) =>
    heldWithoutCopies(held, (answered) => answered === id),
  );
  void services.sync.syncOnce();
  return 'sent';
}
