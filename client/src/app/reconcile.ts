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
 * (`store/coalitions.ts`). Such a card carries no `inner`, and the group's
 * reconcile Proposal holds none even from a card that does: the group gets it
 * through its seat once admitted, so it can't read the room while it's
 * decided on (#313). Nothing here sends anything readable: every event goes
 * sealed, through the store's outbox or the card's envelope.
 *
 * A coalition takes a seat above it the same way (#122), one level up: a card
 * from its row, or a card brought to it, queues its reconcile motion in its
 * own log, signed by this person's coalition key, with the secrets above
 * sealed under its `inner` (`crypto/innerSeal.ts`), so its followers can't
 * open them, and its seat on the card and the genesis states its level. A
 * coalition asking into a formed one seals no `inner` above, as a group's
 * Proposal holds none: it gets it through its seat once admitted (#313).
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { cardChannelOf, deriveCoalitionEntryId, newCardSeed } from '../crypto/card';
import { newGroupSecret } from '../crypto/groupKeys';
import { sealSeatSecrets } from '../crypto/innerSeal';
import { MAX_RECORD_BYTES } from '../crypto/record';
import { roomCommit } from '../crypto/room';
import { seatKeyOf, signSeatProof } from '../crypto/seat';
import { newSigningKeys, publicKeyOf } from '../crypto/sign';
import { genesisAtoms } from '../engine/atomText';
import { can } from '../engine/capabilities';
import { MAX_LEVEL } from '../engine/coalition';
import { refusedBy, seatAbove, seatIn } from '../engine/crossing';
import { atomsOf } from '../engine/documents';
import { type SeatEntry, signEvent } from '../engine/event';
import { fold, type GroupState, TITLE_MAX } from '../engine/fold';
import { DEFAULT_RULES } from '../engine/rules';
import { type Card, CARD_TTL_DAYS, cardLink, openCard, sealCard } from '../coalition/card';
import { clip, NAME_MAX } from '../invite/envelope';
import {
  coalitionKeys,
  type CoalitionKeys,
  heldSecrets,
  newEntry,
  queuedSecrets,
} from '../store/coalitions';
import { type Group, isCoalitionEntry } from '../store/db';
import { eventIdOf } from '../store/eventId';
import { foldGroup } from '../store/expiry';
import { readRecentLog, type RecentLog } from '../store/sync';
import type { Services } from './actions';
import { messages } from './messages';
import type { Route } from './router';

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

/** A reconcile target's coalition: its secret, name and statement. */
type CardCoalition = Pick<Card, 'secret' | 'name' | 'title' | 'atoms'>;

/**
 * A reconcile target and the public seat key its fresh seat secret makes,
 * carrying `inner` only when given: a founding group's (#313).
 */
function reconcileTarget(card: CardCoalition, inner: Uint8Array | undefined) {
  const seatSecret = newSigningKeys().secretKey;
  const fields = {
    kind: 'reconcile',
    secret: base64url(card.secret),
    seat: base64url(seatSecret),
    name: card.name,
    title: card.title,
    atoms: card.atoms,
  } as const;
  const target = inner === undefined ? fields : { ...fields, inner: base64url(inner) };
  return { target, seatSecret, seatKey: base64url(seatKeyOf(seatSecret)) };
}

/** The log a reconcile Proposal goes in: a group's, or a coalition's (#122), with what it seals under. */
interface Lower {
  readonly group: Group;
  /** The log's genesis id, which its events name. */
  readonly id: string;
  readonly state: GroupState;
  /** A coalition's `inner`, which seals its seats above; null for a group. */
  readonly inner: Uint8Array | null;
}

/**
 * A reconcile target for `lower`: a group's carries its secrets readable in
 * its own sealed log; a coalition's (#122) seals them under its `inner`, so
 * its followers, who read its log, can't open them. Either carries the
 * coalition's `inner` only when given: a founding one's (#313).
 */
function targetFor(lower: Lower, card: CardCoalition, inner: Uint8Array | undefined) {
  const made = reconcileTarget(card, inner);
  if (lower.inner === null) return made;
  const held = { secret: card.secret, seat: made.seatSecret };
  const sealed = sealSeatSecrets(
    lower.id,
    lower.inner,
    inner === undefined ? held : { ...held, inner },
  );
  const { name, title, atoms } = card;
  const target = { kind: 'reconcile', sealed, key: made.seatKey, name, title, atoms } as const;
  return { ...made, target };
}

/** The reconcile Proposal's target, as {@link targetFor} makes it. */
type Target = ReturnType<typeof targetFor>['target'];

/** `lower`'s seat in a coalition: its name there, cut as an invite's preview is, its key, and a coalition's level. */
function seatOf(lower: Lower, key: string): SeatEntry {
  const name = clip(lower.state.name, NAME_MAX);
  const level = lower.state.coalition?.level ?? 0;
  return level === 0 ? { name, key } : { name, key, level };
}

/** The signed reconcile Proposal for `target` in `lower`, or null when it's too large to send. */
function reconcileRecord(
  lower: Pick<Lower, 'group' | 'id'>,
  ts: number,
  body: { readonly target: Target; readonly why: string },
) {
  const title = proposalTitle(body.target.name);
  const draft = {
    type: 'proposal',
    group: lower.id,
    ts,
    body: { target: body.target, title, why: body.why },
  } as Parameters<typeof signEvent>[1];
  const signed = signEvent(lower.group.signingKey, draft);
  return signed.record.length > MAX_RECORD_BYTES ? null : signed;
}

/** This device's keys to every coalition it holds (#122). */
async function deviceKeys(services: Services): Promise<ReadonlyMap<string, CoalitionKeys>> {
  const { store } = services;
  return coalitionKeys(await store.listGroups(), await store.listCoalitions());
}

/**
 * Whether this device holds the `inner` of the coalition whose entry is
 * `entryId` (#122, #313), which its card for another coalition seals its seat
 * under: a group admitted into it holds none until a seated group's wrap for
 * its seat arrives.
 */
export async function holdsCoalitionKey(services: Services, entryId: string): Promise<boolean> {
  return ((await deviceKeys(services)).get(entryId)?.inner ?? null) !== null;
}

/**
 * The log `groupId` names on this device, as a reconcile Proposal's home:
 * a group, or a formed coalition this person takes part in (#122).
 *
 * @throws {Error} when the device holds neither, or a coalition's `inner`.
 */
async function lowerOf(services: Services, groupId: string): Promise<Lower> {
  const group = await services.store.getGroup(groupId);
  if (group === undefined) throw new Error('No such group on this device.');
  const state = foldGroup(group);
  if (!isCoalitionEntry(group)) return { group, id: groupId, state, inner: null };
  // An admitted coalition holds its inner only once a seated participant wraps it (#313).
  const inner = (await deviceKeys(services)).get(groupId)?.inner ?? null;
  if (state.group === null || inner === null) throw new Error('No such coalition here.');
  return { group, id: state.group, state, inner };
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
 * group's seat once a genesis names it. From a coalition's row (#122),
 * Reconcile with another coalition does the same one level up: `groupId` is
 * the coalition's entry, its reconcile motion seals the secrets above, and
 * its seat on the card states its level. The card it returns is posted by
 * {@link postCard}. A Proposal too large to send is refused before anything
 * is kept.
 *
 * @throws {Error} when the device isn't in the group or coalition.
 */
export async function makeCard(
  services: Services,
  groupId: string,
  values: CardValues,
): Promise<CardResult> {
  const { store } = services;
  const lower = await lowerOf(services, groupId);
  const coalition = {
    secret: newGroupSecret(),
    inner: newGroupSecret(),
    name: values.name,
    title: messages.card.documentTitle,
    atoms: genesisAtoms(values.statement),
  };
  const { target, seatKey } = targetFor(lower, coalition, coalition.inner);
  const card: Card = { ...coalition, seat: seatOf(lower, seatKey), entries: [] };
  const proposal = reconcileRecord(lower, services.now(), { target, why: values.why });
  // The card holds less than the Proposal, so a Proposal that fits makes a card that fits.
  if (proposal === null) return { outcome: 'too-large' };
  await store.enqueue(groupId, proposal.record);
  await entryFor(services, coalition.secret, { name: values.yourName, joinAs: groupId });
  void services.sync.syncOnce();
  return { outcome: 'queued', proposalId: proposal.id, card };
}

/**
 * Posts `card`'s envelope to a fresh card mailbox, kept {@link CARD_TTL_DAYS}
 * day, and returns its seed only once every PUT has succeeded: what a card
 * link carries, or a front door's inbox (#426).
 *
 * @throws {Error} when the relay can't be reached.
 */
export async function postCardSeed(services: Services, card: Card): Promise<Uint8Array> {
  const seed = newCardSeed();
  const channel = cardChannelOf(seed);
  for (const blob of sealCard(services.seal, channel, card)) {
    await services.relay.putBlob(channel.mailbox, blob, CARD_TTL_DAYS);
  }
  return seed;
}

/**
 * Posts `card`'s envelope as {@link postCardSeed} does, and returns its link
 * only once every PUT has succeeded.
 *
 * @throws {Error} when the relay can't be reached; no link exists then.
 */
export async function postCard(services: Services, card: Card, origin: string): Promise<string> {
  return cardLink(origin, await postCardSeed(services, card));
}

/**
 * A group on this device that may take a card: it can propose there and
 * doesn't hold the coalition; or a coalition this person takes part in that
 * may take a seat above it (#122), by its entry id.
 */
export interface CardGroup {
  readonly groupId: string;
  readonly name: string;
  readonly kind: 'group' | 'coalition';
}

/**
 * A coalition this person takes part in that can't take a formed
 * coalition's card (#549): the card's coalition, `coalition`, sits in
 * `above`, or is on its way to a seat there, and admitting `name` would raise
 * its level. Every name comes from logs this device already holds.
 */
export interface RefusedCard {
  readonly name: string;
  readonly coalition: string;
  readonly above: string;
}

/**
 * An opened card: the card, whether it founds a coalition or admits a group
 * into a formed one, the coalition's log as far as this device read it, the
 * groups on this device that may take it, and the coalitions it can't go to
 * because the card's coalition would refuse them (#549).
 */
export interface FoundCard {
  readonly card: Card;
  readonly mode: 'found' | 'admit';
  readonly log: RecentLog;
  readonly groups: readonly CardGroup[];
  readonly refused: readonly RefusedCard[];
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
    const state = foldGroup(group);
    if (state.group === null || !can(state, group.me.author, 'propose')) return [];
    if ([...heldSecrets(state), ...queuedSecrets(group)].includes(secret)) return [];
    return [{ groupId: group.groupId, name: state.name, kind: 'group' as const }];
  });
}

/** Whether this person may bring a card into the coalition `state` as it folds now (#122). */
export function bringsInto(state: GroupState, me: string): boolean {
  const info = state.coalition;
  if (info?.status !== 'formed' || info.level >= MAX_LEVEL) return false;
  return info.bindings.some((b) => b.author === me) && can(state, me, 'propose');
}

/** The coalitions that may take a card, and those its coalition would refuse (#549). */
interface CardCoalitions {
  readonly groups: CardGroup[];
  readonly refused: RefusedCard[];
}

/** Whether the coalition `state` names the seat `key`, or an admit motion of its does. */
function seatsOrAdmits(state: GroupState, key: string): boolean {
  const info = state.coalition;
  if (info === null) return false;
  return (
    info.seats.some((seat) => seat.key === key) || info.motions.some((m) => m.admit?.key === key)
  );
}

/**
 * Where a coalition `state` stands with a formed coalition's card, `admit`
 * (#549): refused, when that coalition sits above (or is on its way) and
 * `state` would raise its level; left out, when it sits in `state` itself or
 * asks into it, since a coalition can't sit in one inside it;
 * else free to take it. A card that founds a coalition (`admit` null) admits
 * no one, so nothing refuses it.
 */
function standingFor(state: GroupState, admit: GroupState | null): 'free' | RefusedCard | null {
  const above = admit === null ? undefined : seatAbove(admit);
  if (admit === null || above === undefined) return 'free';
  if (seatsOrAdmits(state, above.key)) return null;
  const refused = refusedBy(admit, { level: state.coalition?.level ?? 0 });
  return refused === undefined
    ? 'free'
    : { name: state.name, coalition: admit.name, above: refused.name };
}

/**
 * The coalitions this person takes part in that may take a card for `secret`
 * (#122): formed, below level 3, holding its `inner`, holding no reconcile
 * motion with this secret, in their log or waiting to send, and not the
 * coalition the card names. For a formed coalition's card, folded as
 * `admit`, those it would refuse go to `refused` instead (#549), and one it
 * sits in is left out.
 */
async function coalitionsFor(
  services: Services,
  secret: string,
  admit: GroupState | null,
): Promise<CardCoalitions> {
  const keys = await deviceKeys(services);
  const named = deriveCoalitionEntryId(fromBase64url(secret));
  const held = keys.get(named)?.from ?? [];
  const entries = await services.store.listCoalitions();
  const found: CardCoalitions = { groups: [], refused: [] };
  for (const entry of entries) {
    const state = foldGroup(entry);
    if (!takesCards(entry, state, keys) || entry.groupId === named) continue;
    if (held.some((from) => from.holder === entry.groupId)) continue;
    const standing = standingFor(state, admit);
    if (standing === 'free') {
      found.groups.push({ groupId: entry.groupId, name: state.name, kind: 'coalition' });
    } else if (standing !== null) {
      found.refused.push(standing);
    }
  }
  return found;
}

/**
 * Whether the coalition entry `entry`, folded as `state`, may take a card at
 * all (#122): this device holds its `inner`, and this person may bring one in.
 */
function takesCards(entry: Group, state: GroupState, keys: ReadonlyMap<string, CoalitionKeys>) {
  if ((keys.get(entry.groupId)?.inner ?? null) === null) return false;
  return bringsInto(state, entry.me.author);
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

/**
 * Whether a coalition's log takes a card that founds it, admits a group into
 * it, or neither, or the card is damaged: one that would found a coalition
 * must carry `inner`, which the room derives from (#313).
 */
function modeOf(state: GroupState, card: Card): FoundCard['mode'] | 'used' | 'missing' {
  if (state.group === null) return card.inner === undefined ? 'missing' : 'found';
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
    const state = fold(log.records, log.relayNow);
    const mode = modeOf(state, card);
    if (mode === 'used' || mode === 'missing') return { kind: mode };
    const secret = base64url(card.secret);
    const coalitions = await coalitionsFor(services, secret, mode === 'admit' ? state : null);
    const groups = [...(await groupsFor(services, secret)), ...coalitions.groups];
    return { kind: 'found', found: { card, mode, log, groups, refused: coalitions.refused } };
  } catch {
    return { kind: 'offline' };
  }
}

/**
 * The coalition's genesis, by the bringer's coalition key, naming the card's
 * seat and the group's, and committing to the card's `inner` (#371), so a
 * group admitted later takes only a wrap of the room both founding groups
 * hold. A founding card always carries `inner` (`modeOf`).
 */
function genesisRecord(entry: Group, card: Card, seat: SeatEntry, ts: number) {
  const body = {
    kind: 'coalition',
    name: card.name,
    // A coalition founds exactly one Document, its statement (#92).
    documents: [{ title: card.title, atoms: card.atoms }],
    rules: DEFAULT_RULES,
    seats: [card.seat, seat],
    ...(card.inner === undefined ? {} : { commit: roomCommit(card.inner) }),
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
 * Brought into a coalition this person takes part in (#122), `groupId` is
 * its entry: its reconcile motion seals the secrets above, and its seat
 * states its level. Returns the reconcile Proposal's id.
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
  const lower = await lowerOf(services, groupId);
  const { card } = found;
  // A group or coalition asking into a formed coalition holds no inner until it's admitted (#313).
  const inner = found.mode === 'admit' ? undefined : card.inner;
  const { target, seatSecret, seatKey } = targetFor(lower, card, inner);
  const proposal = reconcileRecord(lower, services.now(), { target, why: '' });
  if (proposal === null) throw new Error('This card is too large to bring.');
  await store.enqueue(groupId, proposal.record);
  if (found.mode === 'admit') {
    await admitPlan(services, found, {
      groupId,
      name: lower.state.name,
      proposal: proposal.id,
      yourName,
    });
  } else {
    const entry = await entryFor(services, card.secret, { name: yourName });
    const seat = { ...seatOf(lower, seatKey), name: lower.state.name };
    const genesis = genesisRecord(entry, card, seat, services.now());
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

/**
 * Where Bring a card goes once it has brought `found` to `groupId`: the
 * group's new reconcile Proposal, or for a coalition (#122), its home, where
 * its motion shows, since its members vote on it in their own groups.
 */
export async function broughtTo(
  services: Services,
  found: FoundCard,
  groupId: string,
  proposalId: string,
): Promise<Route> {
  const picked = found.groups.find((group) => group.groupId === groupId);
  if (picked?.kind !== 'coalition') return { name: 'proposal', groupId, proposalId };
  const entry = await services.store.getGroup(groupId);
  const coalitionId = entry === undefined ? null : foldGroup(entry).group;
  return coalitionId === null ? { name: 'start' } : { name: 'coalition', coalitionId };
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
 * A card from a formed coalition's row (#114): its secret, the participant's
 * seat, the coalition's name and statement as they read now, and its whole
 * log, so the group it's brought to reads all of it. The seat is the one
 * `groupId`'s log holds there: a group's, or a coalition entry's (#122), with
 * its level. It carries no `inner`: whoever it's brought to gets that through
 * its seat once admitted (#313).
 *
 * @throws {Error} when the device holds no such coalition or seat.
 */
export async function admitCard(
  services: Services,
  entryId: string,
  groupId: string,
): Promise<Card> {
  const entry = await services.store.getGroup(entryId);
  const group = await services.store.getGroup(groupId);
  if (entry === undefined || group === undefined) throw new Error('No such coalition here.');
  const coalition = foldGroup(entry);
  const holder = { group, id: groupId, state: foldGroup(group), inner: null };
  const key = seatIn(holder.state, coalition);
  // A coalition's statement is its one Document (#92).
  const [statement] = coalition.documents;
  if (key === null || statement === undefined) throw new Error('This group holds no seat here.');
  return {
    secret: entry.secret,
    seat: seatOf(holder, key),
    name: coalition.name,
    title: statement.title,
    atoms: atomsOf(coalition, statement.id).map((atom) => atom.text),
    entries: entry.log,
  };
}
