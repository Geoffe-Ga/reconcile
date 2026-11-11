/**
 * What Reconcile with another group, Bring a card, Take part and a formed
 * coalition's card do (spec §4 Coalitions; ADR-0036, ADR-0074, ADR-0075 §1;
 * #114), apart from any screen.
 *
 * Making a card queues the group's reconcile Proposal, which carries the new
 * coalition secret, `inner` and the group's seat secret in its own sealed
 * log, keeps the coalition's entry on this device with a fresh key and the
 * name its maker chose, then posts the card's envelope to a fresh card
 * mailbox: only A's public seat key leaves the group. Bringing a card queues
 * the other group's reconcile Proposal with the card's name and statement,
 * writes the coalition's genesis naming both seats, and joins under the
 * bringer's seat. A card from a formed coalition admits the group instead:
 * once its reconcile Proposal passes, the sync loop proposes the admission
 * (`store/coalitions.ts`). Nothing here sends anything readable: every event
 * goes sealed, through the store's outbox or the card's envelope.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { cardChannelOf, deriveCoalitionEntryId, newCardSeed } from '../crypto/card';
import { newGroupSecret } from '../crypto/groupKeys';
import { MAX_RECORD_BYTES } from '../crypto/record';
import { seatKeyOf, signSeatProof } from '../crypto/seat';
import { newSigningKeys, publicKeyOf } from '../crypto/sign';
import { genesisAtoms } from '../engine/atomText';
import { can } from '../engine/capabilities';
import { signEvent } from '../engine/event';
import { fold, type GroupState, TITLE_MAX } from '../engine/fold';
import { DEFAULT_RULES } from '../engine/rules';
import {
  type Card,
  cardFits,
  CARD_TTL_DAYS,
  cardLink,
  openCard,
  sealCard,
} from '../coalition/card';
import { clip } from '../invite/envelope';
import { heldSecrets, newEntry, queuedSecrets } from '../store/coalitions';
import type { Group } from '../store/db';
import { eventIdOf } from '../store/eventId';
import { readRecentLog, type RecentLog } from '../store/sync';
import type { Services } from './actions';
import { messages } from './messages';

/** What Reconcile with another group asks for, each trimmed. */
export interface CardValues {
  /** The coalition's name, 1–120 code points. */
  readonly name: string;
  /** Its first statement, split into sections at blank lines. */
  readonly statement: string;
  /** Why, for the group's reconcile Proposal. */
  readonly why: string;
  /** The maker's name in the coalition. */
  readonly yourName: string;
}

/** A made card's reconcile Proposal, and the card to post, or why it wasn't made. */
export type CardResult =
  | { readonly outcome: 'queued'; readonly proposalId: string; readonly card: Card }
  | { readonly outcome: 'too-large' };

/** A reconcile Proposal's title: "Reconcile into <name>", cut to the longest title. */
function proposalTitle(name: string): string {
  return clip(messages.card.proposalTitle(name), TITLE_MAX);
}

/** A reconcile target and the public seat key its fresh seat secret makes. */
function reconcileTarget(card: Pick<Card, 'secret' | 'inner' | 'name' | 'title' | 'atoms'>) {
  const seatSecret = newSigningKeys().secretKey;
  const target = {
    kind: 'reconcile',
    secret: base64url(card.secret),
    inner: base64url(card.inner),
    seat: base64url(seatSecret),
    name: card.name,
    title: card.title,
    atoms: card.atoms,
  } as const;
  return { target, seatSecret, seatKey: base64url(seatKeyOf(seatSecret)) };
}

/** The group's signed reconcile Proposal for `target`, or null when it's too large to send. */
function reconcileRecord(
  group: Group,
  ts: number,
  body: { readonly target: ReturnType<typeof reconcileTarget>['target']; readonly why: string },
) {
  const title = proposalTitle(body.target.name);
  const signed = signEvent(group.signingKey, {
    type: 'proposal',
    group: group.groupId,
    ts,
    body: { target: body.target, title, why: body.why },
  });
  return signed.record.length > MAX_RECORD_BYTES ? null : signed;
}

/** The coalition's entry on this device, kept now with `plan` when it has none. */
async function entryFor(
  services: Services,
  secret: Uint8Array,
  plan: Parameters<typeof newEntry>[1],
): Promise<Group> {
  const { store } = services;
  const id = deriveCoalitionEntryId(secret);
  const held = await store.getGroup(id);
  if (held === undefined) return store.addGroup(newEntry(secret, plan));
  await store.planCoalition(id, {
    ...(plan?.name === undefined ? {} : { name: plan.name }),
    ...(plan?.joinAs === undefined ? {} : { joinAs: plan.joinAs }),
    ...(plan?.admitting === undefined ? {} : { admitting: plan.admitting }),
  });
  const updated = await store.getGroup(id);
  if (updated === undefined) throw new Error('The coalition’s entry went away.');
  return updated;
}

/**
 * Reconcile with another group's Submit: makes the coalition secret, `inner`
 * and the group's seat, queues the group's reconcile Proposal, and keeps the
 * coalition's entry with the maker's name, planning to join under the
 * group's seat once a genesis names it. The card it returns is posted by
 * {@link postCard}. A Proposal or card too large to send is refused before
 * anything is kept.
 *
 * @throws {Error} when the device isn't in the group.
 */
export async function makeCard(
  services: Services,
  groupId: string,
  values: CardValues,
): Promise<CardResult> {
  const { store } = services;
  const group = await store.getGroup(groupId);
  if (group === undefined) throw new Error('No such group on this device.');
  const state = fold(group.log, group.relayNow);
  const coalition = {
    secret: newGroupSecret(),
    inner: newGroupSecret(),
    name: values.name,
    title: messages.card.documentTitle,
    atoms: genesisAtoms(values.statement),
  };
  const { target, seatKey } = reconcileTarget(coalition);
  const card: Card = { ...coalition, seat: { name: state.name, key: seatKey }, entries: [] };
  const proposal = reconcileRecord(group, services.now(), { target, why: values.why });
  if (proposal === null || !cardFits(card)) return { outcome: 'too-large' };
  await store.enqueue(groupId, proposal.record);
  await entryFor(services, coalition.secret, { name: values.yourName, joinAs: groupId });
  void services.sync.syncOnce();
  return { outcome: 'queued', proposalId: proposal.id, card };
}

/**
 * Posts `card`'s envelope to a fresh card mailbox, kept {@link CARD_TTL_DAYS}
 * day, and returns its link only once every PUT has succeeded.
 *
 * @throws {Error} when the relay can't be reached; no link exists then.
 */
export async function postCard(services: Services, card: Card, origin: string): Promise<string> {
  const seed = newCardSeed();
  const channel = cardChannelOf(seed);
  for (const blob of sealCard(services.seal, channel, card)) {
    await services.relay.putBlob(channel.mailbox, blob, CARD_TTL_DAYS);
  }
  return cardLink(origin, seed);
}

/** A group on this device that may take a card: it can propose there and doesn't hold the coalition. */
export interface CardGroup {
  readonly groupId: string;
  readonly name: string;
}

/**
 * An opened card: the card, whether it founds a coalition or admits a group
 * into a formed one, the coalition's log as far as this device read it, and
 * the groups on this device that may take it.
 */
export interface FoundCard {
  readonly card: Card;
  readonly mode: 'found' | 'admit';
  readonly log: RecentLog;
  readonly groups: readonly CardGroup[];
}

/** What opening a card found. */
export type CardLookup =
  | { readonly kind: 'found'; readonly found: FoundCard }
  | { readonly kind: 'used' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'offline' };

/**
 * The groups on this device that may take a card for `secret`: ones it is
 * in, not leaving or read-only, where this member can propose, and that hold
 * no reconcile Proposal with this secret, in their log or waiting to send.
 */
async function groupsFor(services: Services, secret: string): Promise<CardGroup[]> {
  const groups = await services.store.listGroups();
  return groups.flatMap((group) => {
    if (group.archived !== undefined || group.leaving !== undefined) return [];
    const state = fold(group.log, group.relayNow);
    if (state.group === null || !can(state, group.me.author, 'propose')) return [];
    if ([...heldSecrets(state), ...queuedSecrets(group)].includes(secret)) return [];
    return [{ groupId: group.groupId, name: state.name }];
  });
}

/**
 * The coalition a card names, as far as the relay holds it: the card's own
 * log for a card from a formed coalition, else its mailboxes' last two weeks,
 * which hold any genesis written since the card was made.
 */
async function coalitionLog(services: Services, card: Card, now: number, instance: string) {
  if (card.entries.length > 0) {
    const cursor = card.entries.reduce((high, record) => Math.max(high, record.seq), 0);
    return { records: [...card.entries], cursor, relayNow: now, instance };
  }
  return readRecentLog(services.relay, services.seal, card.secret, now);
}

/** Whether a coalition's log takes a card that founds it, admits a group into it, or neither. */
function modeOf(state: GroupState): FoundCard['mode'] | 'used' {
  if (state.group === null) return 'found';
  return state.coalition?.status === 'formed' ? 'admit' : 'used';
}

/**
 * Opens the card the seed names: reads its mailbox, opens the envelope,
 * then reads the coalition, as far as the relay holds it, to see whether it
 * still waits for a genesis (`found`), has formed (`admit`), or is forming or
 * was declined (`used`). Only mailbox ids go to the relay, and nothing is
 * stored. An empty mailbox (an expired card) or a damaged one reads as
 * `missing`.
 */
export async function lookupCard(services: Services, seed: Uint8Array): Promise<CardLookup> {
  const channel = cardChannelOf(seed);
  try {
    const page = await services.relay.getBlobs(channel.mailbox, 0);
    const card = openCard(
      services.seal,
      channel,
      page.records.map((record) => record.data),
    );
    if (card === null) return { kind: 'missing' };
    const log = await coalitionLog(services, card, page.now, page.instance);
    const mode = modeOf(fold(log.records, log.relayNow));
    if (mode === 'used') return { kind: 'used' };
    const groups = await groupsFor(services, base64url(card.secret));
    return { kind: 'found', found: { card, mode, log, groups } };
  } catch {
    return { kind: 'offline' };
  }
}

/** The coalition's genesis, by the bringer's coalition key, naming the card's seat and the group's. */
function genesisRecord(entry: Group, card: Card, seat: { name: string; key: string }, ts: number) {
  const body = {
    kind: 'coalition',
    name: card.name,
    title: card.title,
    atoms: card.atoms,
    rules: DEFAULT_RULES,
    seats: [card.seat, seat],
  } as const;
  return signEvent(entry.signingKey, { type: 'genesis', group: '', ts, body });
}

/** The bringer's join under `seatKey`, with the seat's proof for their coalition key. */
function joinRecord(
  entry: Group,
  id: string,
  seat: { secret: Uint8Array; key: string },
  ts: number,
) {
  const proof = base64url(signSeatProof(seat.secret, id, publicKeyOf(entry.signingKey)));
  const body = { name: entry.me.name, seat: seat.key, proof };
  return signEvent(entry.signingKey, { type: 'join', group: id, ts, body }).record;
}

/**
 * Bring a card's Submit: queues `groupId`'s reconcile Proposal with the
 * card's name and statement, under a fresh seat, and keeps or updates the
 * coalition's entry with `yourName`. For a coalition still to form it also
 * writes the genesis, naming the card's seat and this group's, and joins
 * under this group's seat; for a formed one it keeps the coalition's log and
 * plans the admission, which the sync loop proposes once the group passes.
 * Returns the reconcile Proposal's id.
 *
 * @throws {Error} when the device isn't in the group, or a record is too large.
 */
export async function bringCard(
  services: Services,
  found: FoundCard,
  groupId: string,
  yourName: string,
): Promise<string> {
  const { store } = services;
  const group = await store.getGroup(groupId);
  if (group === undefined) throw new Error('No such group on this device.');
  const state = fold(group.log, group.relayNow);
  const { card } = found;
  const { target, seatSecret, seatKey } = reconcileTarget(card);
  const proposal = reconcileRecord(group, services.now(), { target, why: '' });
  if (proposal === null) throw new Error('This card is too large to bring.');
  await store.enqueue(groupId, proposal.record);
  if (found.mode === 'admit') {
    await admitPlan(services, found, {
      groupId,
      name: state.name,
      proposal: proposal.id,
      yourName,
    });
  } else {
    const entry = await entryFor(services, card.secret, { name: yourName });
    const genesis = genesisRecord(entry, card, { name: state.name, key: seatKey }, services.now());
    const join = joinRecord(
      entry,
      genesis.id,
      { secret: seatSecret, key: seatKey },
      services.now(),
    );
    await store.enqueueAll(entry.groupId, [genesis.record, join]);
  }
  void services.sync.syncOnce();
  return proposal.id;
}

/** What {@link admitPlan} needs of the group a formed coalition's card was brought to. */
interface Brought {
  readonly groupId: string;
  readonly name: string;
  readonly proposal: string;
  readonly yourName: string;
}

/**
 * Keeps a formed coalition's entry, with the log the card carried or the
 * relay held, and plans its admission of the group `brought` names.
 */
async function admitPlan(services: Services, found: FoundCard, brought: Brought) {
  const { card, log } = found;
  const title = clip(messages.card.admitTitle(brought.name), TITLE_MAX);
  const admitting = { group: brought.groupId, proposal: brought.proposal, title, why: '' };
  const entry = await entryFor(services, card.secret, { name: brought.yourName, admitting });
  const pull = { ...log, records: [...log.records], lastSyncAt: services.now() };
  await services.store.applyPull(entry.groupId, pull, eventIdOf);
}

/**
 * Take part (#114): plans to join the coalition `entryId` under `groupId`'s
 * seat as `name`, which the sync loop does at once.
 */
export async function takePart(
  services: Services,
  entryId: string,
  groupId: string,
  name: string,
): Promise<void> {
  await services.store.planCoalition(entryId, { name, joinAs: groupId });
  void services.sync.syncOnce();
}

/**
 * A card from a formed coalition's row (#114): its secret and `inner`, the
 * participant's group's seat, the coalition's name and statement as they
 * read now, and its whole log, so the group it's brought to reads all of it.
 *
 * @throws {Error} when the device holds no such coalition or group seat.
 */
export async function admitCard(
  services: Services,
  entryId: string,
  groupId: string,
): Promise<Card> {
  const entry = await services.store.getGroup(entryId);
  const group = await services.store.getGroup(groupId);
  if (entry === undefined || group === undefined) throw new Error('No such coalition here.');
  const coalition = fold(entry.log, entry.relayNow);
  const state = fold(group.log, group.relayNow);
  const seats = new Set((coalition.coalition?.seats ?? []).map((seat) => seat.key));
  const target = state.proposals
    .map((p) => p.target)
    .find((t) => t.kind === 'reconcile' && seats.has(t.key));
  if (target?.kind !== 'reconcile') throw new Error('This group holds no seat here.');
  const { inner, key } = target;
  return {
    secret: entry.secret,
    inner: fromBase64url(inner),
    seat: { name: state.name, key },
    name: coalition.name,
    title: coalition.title,
    atoms: coalition.atoms.map((atom) => atom.text),
    entries: entry.log,
  };
}
