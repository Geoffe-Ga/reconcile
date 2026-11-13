/**
 * The coalitions a device holds (spec §4 Coalitions; ADR-0036, ADR-0075 §1;
 * #114): one store entry per coalition secret any group on the device holds,
 * synced by the same loop as a group (`sync.ts`), and what crosses between
 * them after each pass.
 *
 * Each reconcile Proposal in a group's log carries the coalition's secret.
 * For each secret, the device keeps one entry (`kind: 'coalition'`), under an
 * id derived from the secret (`crypto/card.ts`), so a device in two of the
 * coalition's groups keeps one. The entry has its own log, cursors and
 * outbox, its mailboxes derived from the secret as a group's are, and `me`:
 * a fresh signing key made for this coalition alone (ADR-0009), and the name
 * its person takes there, none until they choose one.
 *
 * After each pass, for each coalition whose genesis has arrived:
 *
 * - a device that plans to join under a group's seat (the card's maker, or
 *   someone whose group was just admitted) joins once the coalition names
 *   that seat, with the seat's proof for its key (`crypto/seat.ts`), the seat
 *   secret read from the group's own reconcile Proposal;
 * - a device whose key is bound to a seat queues what its group owes there
 *   (`resultsToReport`): only a pass or fail per motion and seat crosses;
 * - it also queues the promotion records its group owes there (#126,
 *   `promotionsOwed`): one per Dispatch the group passed whose ceiling
 *   leaves that level, carrying the Dispatch's words and nothing else;
 * - a device that brought a formed coalition's card to a group proposes
 *   admitting it once that group's reconcile Proposal has passed, with its
 *   seat's X25519 key, and plans to join under its seat; if it didn't pass,
 *   the plan goes;
 * - a device whose key is bound to a seat whose group here holds the room's
 *   `inner`, the one the coalition's genesis commits to, wraps it to each
 *   seat admitted since that its participant hasn't wrapped for yet (#313,
 *   #371), so the admitted group can read the room only once it's seated
 *   ({@link innerOf}), and takes only a wrap of that `inner`.
 *
 * Each acts for a group only while this device's member still does there
 * (#377): from the final pass of a removal of them, none of it runs for that
 * group, before the `remove` archives it here.
 *
 * A group's own fold takes the motions its seats decide (`motionsFor`), so
 * its members vote on them as on any Proposal ({@link foldWithCoalitions}). Nothing
 * here reads a person's key in one log to find them in another.
 *
 * Coalitions nest (#122). A coalition's reconcile motion carries the secrets
 * of the coalition above sealed under a key from its own `inner`
 * (`crypto/innerSeal.ts`), which only its member groups' logs hold, so this
 * device keeps an entry for every coalition reachable upward from its groups
 * ({@link coalitionKeys}), and a coalition entry acts for its seat above as
 * a group acts for its own: it joins under it, reports its one result up, and
 * proposes its admission. A device that only follows a coalition, holding its
 * secret but not its `inner`, opens none of them, so it keeps no entry above.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { openSeatSecrets } from '../crypto/innerSeal';
import { roomCommit, seatKxOf, unwrapInner, wrapInner } from '../crypto/room';
import { seatKeyOf, signSeatProof } from '../crypto/seat';
import { newSigningKeys, publicKeyOf } from '../crypto/sign';
import { can, isOusted } from '../engine/capabilities';
import { type Coalition, MAX_LEVEL, type Motion, type ReconcileChange } from '../engine/coalition';
import { foldTogether, motionsFor, promotionsOwed, resultsToReport } from '../engine/crossing';
import {
  type GroupResultBody,
  type ParsedEvent,
  parseRecord,
  type ReconcileTarget,
  type SealedReconcileTarget,
  signEvent,
} from '../engine/event';
import { fold, type GroupState } from '../engine/fold';
import type { CarriedCoalition } from '../invite/envelope';
import { type Group, isArchive, isCoalitionEntry, type NewGroup, type Store } from './db';
import { eventIdOf } from './eventId';
import { foldGroup } from './expiry';

/** A coalition entry with its log folded. */
export interface HeldCoalition {
  readonly entry: Group;
  readonly state: GroupState;
}

/** A reconcile target as a log on this device holds it, with its Proposal's id. */
interface Held<T> {
  readonly proposal: string;
  readonly target: T;
}

/** The reconcile targets a record list's Proposals carry, readable or sealed, each with its id. */
function targetsIn(records: readonly Uint8Array[]): AnyHeld[] {
  return records.flatMap((bytes) => {
    const parsed = parseRecord(bytes);
    const event = parsed?.event;
    if (parsed === null || event?.type !== 'proposal' || !('target' in event.body)) return [];
    const { target } = event.body;
    return target.kind === 'reconcile' ? [{ proposal: parsed.id, target }] : [];
  });
}

/** The reconcile targets `state`'s Proposals carry, readable or sealed, each with its id. */
function targetsOf(state: Pick<GroupState, 'proposals'>): AnyHeld[] {
  return state.proposals.flatMap((p) =>
    p.target.kind === 'reconcile' ? [{ proposal: p.id, target: p.target }] : [],
  );
}

/** Any reconcile target a log holds, readable or sealed. */
type AnyHeld = Held<ReconcileTarget | SealedReconcileTarget>;

/** A group's readable reconcile targets (#100). */
function plain(held: readonly AnyHeld[]): Held<ReconcileTarget>[] {
  return held.flatMap(({ proposal, target }) => ('secret' in target ? [{ proposal, target }] : []));
}

/** A coalition's sealed reconcile targets (#122). */
function sealedOf(held: readonly AnyHeld[]): Held<SealedReconcileTarget>[] {
  return held.flatMap(({ proposal, target }) => ('sealed' in target ? [{ proposal, target }] : []));
}

/** The coalition secrets `state` holds, in base64url: each of its reconcile Proposals'. */
export function heldSecrets(state: Pick<GroupState, 'proposals'>): string[] {
  return plain(targetsOf(state)).map(({ target }) => target.secret);
}

/** The coalition secrets the reconcile Proposals in `group`'s outbox carry, in base64url. */
export function queuedSecrets(group: Pick<Group, 'outbox'>): string[] {
  return plain(targetsIn(group.outbox)).map(({ target }) => target.secret);
}

/**
 * What this device holds of one coalition (#122): its secret and `inner`,
 * each log on it whose reconcile Proposal or motion carries them (a group's
 * id, or a coalition's entry id, with that Proposal's id), and the seat
 * secrets it holds there, by public seat key. `inner` is null for a seat
 * admitted into a formed coalition until a seated participant's wrap for it
 * arrives (#313).
 */
export interface CoalitionKeys {
  readonly secret: Uint8Array;
  readonly inner: Uint8Array | null;
  readonly from: readonly { readonly holder: string; readonly proposal: string }[];
  readonly seats: ReadonlyMap<string, Uint8Array>;
}

/** A {@link CoalitionKeys} as {@link coalitionKeys} builds it up. */
interface KeysDraft {
  readonly secret: Uint8Array;
  inner: Uint8Array | null;
  readonly from: { readonly holder: string; readonly proposal: string }[];
  readonly seats: Map<string, Uint8Array>;
}

/**
 * One coalition's keys, read from the log `holder`'s Proposal `proposal`:
 * `inner` is null where it carries none, as one asking into a formed
 * coalition doesn't (#313).
 */
interface Found {
  readonly secret: Uint8Array;
  readonly inner: Uint8Array | null;
  readonly seat: Uint8Array;
  readonly holder: string;
  readonly proposal: string;
}

/**
 * Adds what `found` holds to `keys`; returns whether it was a coalition `keys`
 * lacked, or gave one its `inner`.
 */
function remember(keys: Map<string, KeysDraft>, found: Found): boolean {
  const id = deriveCoalitionEntryId(found.secret);
  const known = keys.get(id);
  const draft: KeysDraft = known ?? {
    secret: found.secret,
    inner: null,
    from: [],
    seats: new Map(),
  };
  const { holder, proposal } = found;
  if (!draft.from.some((f) => f.holder === holder && f.proposal === proposal)) {
    draft.from.push({ holder, proposal });
  }
  draft.seats.set(base64url(seatKeyOf(found.seat)), found.seat);
  keys.set(id, draft);
  const inner = draft.inner === null ? found.inner : null;
  if (inner !== null) draft.inner = inner;
  return known === undefined || inner !== null;
}

/**
 * What {@link coalitionKeys} reads of a group or a coalition entry: its id,
 * its log and outbox, and what it folds them at. A coalition's log an invite
 * carried (#279) is read the same way before the device keeps it.
 */
export type KeysSource = Pick<Group, 'groupId' | 'log' | 'outbox' | 'relayNow' | 'cleared'>;

/** The coalitions a group's readable reconcile targets carry, in its log and its outbox. */
function fromGroup(group: KeysSource): Found[] {
  const held = [...targetsOf(foldGroup(group)), ...targetsIn(group.outbox)];
  return plain(held).map(({ proposal, target }) => ({
    secret: fromBase64url(target.secret),
    inner: target.inner === undefined ? null : fromBase64url(target.inner),
    seat: fromBase64url(target.seat),
    holder: group.groupId,
    proposal,
  }));
}

/**
 * A seat a coalition holds in a coalition above it (#122), opened from its
 * sealed reconcile motion: the coalition above's secret, its `inner` where
 * the motion carried one, as a founding seat's does, the seat secret and its
 * public key, and the motion's id.
 */
export interface SeatAbove {
  readonly secret: Uint8Array;
  readonly inner: Uint8Array | null;
  readonly seat: Uint8Array;
  readonly key: string;
  readonly proposal: string;
}

/** Whether the seat secret `seat` makes the public seat key `key` a sealed target states (#122, #375). */
function makesKey(seat: Uint8Array, key: string): boolean {
  return base64url(seatKeyOf(seat)) === key;
}

/**
 * The seats above the coalition `id` that `held`, its sealed reconcile
 * targets, hold, each opened under its `inner` (#122). A field whose seat
 * secret doesn't make the public key the motion states is no seat to act
 * for, so it is left out (#375): no device joins, reports or asks in for it.
 */
function openedAbove(
  id: string,
  inner: Uint8Array,
  held: readonly Held<SealedReconcileTarget>[],
): SeatAbove[] {
  return held.flatMap(({ proposal, target }) => {
    const opened = openSeatSecrets(id, inner, target.sealed);
    if (opened === null || !makesKey(opened.seat, target.key)) return [];
    return [{ ...opened, inner: opened.inner ?? null, key: target.key, proposal }];
  });
}

/**
 * Whether the sealed reconcile target `target` of the coalition `coalitionId`
 * misstates its seat (#375): its `sealed` opens under `inner`, and the seat
 * secret inside doesn't make the `key` it states. The fold can't open
 * `sealed`, so it takes `key` as stated, and a hand-made motion could give
 * the seat above to a key nobody holds. False when `sealed` doesn't open,
 * since this device can't judge it then.
 */
export function misstatesSeat(
  coalitionId: string,
  inner: Uint8Array,
  target: SealedReconcileTarget,
): boolean {
  const opened = openSeatSecrets(coalitionId, inner, target.sealed);
  return opened !== null && !makesKey(opened.seat, target.key);
}

/**
 * The seats above the coalition folded as `state` that its log's sealed
 * reconcile motions hold, opened under its `inner` (#122): what lets a
 * device in its groups read a room above it once seated (#344).
 */
export function seatsAbove(state: GroupState, inner: Uint8Array): SeatAbove[] {
  return state.group === null ? [] : openedAbove(state.group, inner, sealedOf(targetsOf(state)));
}

/**
 * The coalitions above `entry`, folded as `state`, its sealed reconcile
 * targets carry, in its log and its outbox, that open under its `inner`
 * (#122), as {@link openedAbove} opens them.
 */
function fromCoalition(entry: KeysSource, state: GroupState, inner: Uint8Array): Found[] {
  const id = state.group;
  if (id === null) return [];
  const held = sealedOf([...targetsOf(state), ...targetsIn(entry.outbox)]);
  return openedAbove(id, inner, held).map((above) => ({ ...above, holder: entry.groupId }));
}

/**
 * The first wrap of `coalition`'s room `inner` for the seat `seatKey` that its
 * seat secret opens to the `inner` the genesis commits to (#313, #371), or
 * null: a wrap of another `inner`, which a seated participant could make of
 * their own, is passed over, and a coalition whose genesis commits to none
 * gives no wrap at all.
 */
function unwrapFor(
  coalition: Pick<Coalition, 'wraps' | 'commit'>,
  coalitionId: string,
  seatKey: string,
  seatSecret: Uint8Array,
): Uint8Array | null {
  const { commit } = coalition;
  if (commit === null) return null;
  for (const { seat, wrap } of coalition.wraps) {
    if (seat !== seatKey) continue;
    const inner = unwrapInner({ coalitionId, seat, wrap, seatSecret, commit });
    if (inner !== null) return inner;
  }
  return null;
}

/** The `inner` a wrap in `state`'s log gives one of `seats`, by public key, or null (#313). */
function wrappedInner(state: GroupState, seats: ReadonlyMap<string, Uint8Array>) {
  const { coalition, group } = state;
  if (coalition === null || group === null) return null;
  for (const [key, secret] of seats) {
    const inner = unwrapFor(coalition, group, key, secret);
    if (inner !== null) return inner;
  }
  return null;
}

/**
 * Gives each coalition in `keys` without an `inner` the one a wrap for one of
 * its seats here opens, in its entry's log as `states` folds it (#313).
 * Returns whether it gave any.
 */
function unwrapInners(keys: Map<string, KeysDraft>, states: ReadonlyMap<string, GroupState>) {
  let gave = false;
  for (const [id, draft] of keys) {
    const state = draft.inner === null ? states.get(id) : undefined;
    const inner = state === undefined ? null : wrappedInner(state, draft.seats);
    if (inner === null) continue;
    draft.inner = inner;
    gave = true;
  }
  return gave;
}

/**
 * Every coalition this device holds keys to (#114, #122), by entry id: each
 * one a group's readable reconcile target carries, then, up to
 * {@link MAX_LEVEL} levels, each one above that a coalition's sealed target
 * carries, opened under that coalition's `inner`. A seat admitted into a
 * formed coalition gets its `inner` from a wrap in that coalition's log
 * (#313). A coalition this device holds no `inner` of, as a follower, or as
 * a seat no one has wrapped for yet, opens nothing.
 */
export function coalitionKeys(
  groups: readonly KeysSource[],
  coalitions: readonly KeysSource[],
): ReadonlyMap<string, CoalitionKeys> {
  const keys = new Map<string, KeysDraft>();
  const states = new Map(coalitions.map((entry) => [entry.groupId, foldGroup(entry)]));
  for (const group of groups) for (const found of fromGroup(group)) remember(keys, found);
  unwrapInners(keys, states);
  for (let level = 1; level < MAX_LEVEL; level += 1) {
    const found = coalitions.flatMap((entry) => {
      const inner = keys.get(entry.groupId)?.inner ?? null;
      const state = states.get(entry.groupId);
      return inner === null || state === undefined ? [] : fromCoalition(entry, state, inner);
    });
    const added = found.map((f) => remember(keys, f)).some(Boolean);
    const unwrapped = unwrapInners(keys, states);
    if (!added && !unwrapped) break;
  }
  return keys;
}

/**
 * A new entry for the coalition whose secret is `secret` (#114): a fresh
 * signing key for this coalition alone, no name yet, and `plan`, or, for a
 * coalition only followed (#124), `following`, whose key signs nothing.
 */
export function newEntry(
  secret: Uint8Array,
  plan: Pick<NewGroup, 'joinAs' | 'admitting' | 'following'> & { readonly name?: string } = {},
): NewGroup {
  const { secretKey, publicKey } = newSigningKeys();
  const { name = '', ...rest } = plan;
  return {
    kind: 'coalition',
    groupId: deriveCoalitionEntryId(secret),
    secret: Uint8Array.from(secret),
    signingKey: secretKey,
    me: { author: base64url(publicKey), name },
    ...rest,
  };
}

/** What {@link ensureEntries} last read of a group: its log's and outbox's lengths. */
function readMark(group: Pick<Group, 'log' | 'outbox'>): string {
  return `${String(group.log.length)}/${String(group.outbox.length)}`;
}

/** Keeps a new entry for each of `secrets` the device has none for; another tab may make it first. */
async function keepEntries(store: Store, held: Set<string>, secrets: readonly Uint8Array[]) {
  for (const secret of secrets) {
    if (held.has(deriveCoalitionEntryId(secret))) continue;
    const entry = newEntry(secret);
    held.add(entry.groupId);
    await store.addGroup(entry).catch(() => undefined);
  }
}

/**
 * Keeps an entry for each coalition secret a group on the device holds, in
 * its log or its outbox, that has none yet. Another tab may make the same
 * entry first: then the device keeps that one. `read` remembers each group as
 * this last read it, by its id, so a group that hasn't changed since isn't
 * folded again; the sync loop keeps one for its life. Then it keeps one for
 * each coalition above them that a coalition entry's sealed reconcile target
 * carries (#122). An entry made now has no log yet, so the one above it
 * follows on a later pass, once its log is in. Last, while the device holds
 * any coalition, it purges what an archive alone held, should the app have
 * closed before its settle could ({@link dropArchived}, #405).
 */
export async function ensureEntries(
  store: Store,
  read: Map<string, string> = new Map(),
): Promise<void> {
  const held = new Set((await store.listCoalitions()).map((entry) => entry.groupId));
  const all = await store.listGroups();
  // A removed member's copy or a dissolved group reads nothing new, a coalition's log included,
  // and no coalition stays on the device through it (#115, #108, #278).
  const groups = all.filter((group) => !isArchive(group.archived));
  for (const group of groups) {
    const mark = readMark(group);
    if (read.get(group.groupId) === mark) continue;
    const secrets = [...heldSecrets(foldGroup(group)), ...queuedSecrets(group)];
    await keepEntries(store, held, secrets.map(fromBase64url));
    read.set(group.groupId, mark);
  }
  const keys = coalitionKeys(groups, await store.listCoalitions());
  await keepEntries(
    store,
    held,
    [...keys.values()].map((k) => k.secret),
  );
  if (held.size > 0) await dropArchived(store, all, read);
}

/**
 * Whether the coalition `id` stays reached on this device without the group
 * it lost: another group holds it, or a coalition below it that one holds,
 * whose `inner` may still arrive in a wrap (#313), carries its seat.
 */
function stillReached(
  id: string,
  own: ReadonlyMap<string, CoalitionKeys>,
  kept: ReadonlyMap<string, CoalitionKeys>,
): boolean {
  return kept.has(id) || (own.get(id)?.from ?? []).some(({ holder }) => kept.has(holder));
}

/**
 * Purges the coalition entries that `lost` alone held on this device (#278;
 * CLAUDE.md, consent and reversibility): a group this member left, once the
 * relay has the leave (#77), one a vote removed them from (#115), or one that
 * dissolved (#108). Each goes with its secret, log, keys, outbox and sync
 * state, and so do the coalitions above that only they reached (#122); a
 * room goes with its coalition on the next pass (`keepRooms`). An entry
 * another live group on the device still holds, or reaches through a
 * coalition it holds, whose `inner` may still arrive in a wrap (#313), stays,
 * and so does one this device follows by its link (#124), which no group
 * needs to hold.
 */
export async function dropCoalitionsOf(store: Store, lost: Group): Promise<void> {
  const entries = await store.listCoalitions();
  const own = coalitionKeys([lost], entries);
  if (own.size === 0) return;
  const others = (await store.listGroups()).filter(
    (group) => group.groupId !== lost.groupId && !isArchive(group.archived),
  );
  const kept = coalitionKeys(others, entries);
  for (const id of own.keys()) {
    const entry = entries.find((each) => each.groupId === id);
    if (entry === undefined || entry.following === true || stillReached(id, own, kept)) continue;
    await store.purgeGroup(id);
  }
}

/**
 * Purges what each archive among `groups` alone held ({@link dropCoalitionsOf}),
 * once for each as `read` last saw it (#405). `settleRemoval` and
 * `settleDissolve` archive a group and then drop its coalitions, and the app
 * may close between the two writes; the sync loop never settles an archive
 * again, so each pass makes sure here.
 */
async function dropArchived(store: Store, groups: readonly Group[], read: Map<string, string>) {
  for (const group of groups) {
    if (!isArchive(group.archived)) continue;
    const mark = `${readMark(group)} ${group.archived.reason}`;
    if (read.get(group.groupId) === mark) continue;
    await dropCoalitionsOf(store, group);
    read.set(group.groupId, mark);
  }
}

/**
 * The coalitions an invite to `group` carries (#279): the relay-accepted log
 * of each coalition entry here that the group reaches ({@link coalitionKeys},
 * a nested one through the coalition below it), nearest first, so a newcomer
 * reads a coalition that formed before the relay's 30 days as they read the
 * group (#73). A coalition this device follows only by its link (#124) isn't
 * one the group reaches, so it stays here; one with no log yet has nothing
 * to carry.
 */
export async function carriedCoalitions(
  store: Pick<Store, 'listCoalitions'>,
  group: Group,
): Promise<CarriedCoalition[]> {
  const entries = await store.listCoalitions();
  const byId = new Map(entries.map((entry) => [entry.groupId, entry]));
  return [...coalitionKeys([group], entries).keys()].flatMap((id) => {
    const entry = byId.get(id);
    if (entry === undefined || entry.log.length === 0) return [];
    return [{ secret: entry.secret, entries: entry.log }];
  });
}

/** Where a carried log was read: the invite GET's relay minute and instance, and the device clock then. */
export interface CarriedRead {
  readonly relayNow: number;
  readonly instance: string;
  readonly lastSyncAt: number;
}

/**
 * Keeps on this device each coalition an invite to `groupId` carried (#279)
 * that the group reaches, judged with the carried logs themselves, so a
 * nested coalition counts through the carried one below it. A new entry takes
 * its log as a pull read at `read`, through sync's verify and dedupe, as Bring
 * takes a card's (#114); an entry the device keeps already, or that another
 * tab makes first, merges in what it lacks, as a device already in the group
 * merges an invite's log (#73). Nothing an inviter carried that the group
 * doesn't reach, and nothing at all for a group this device keeps as an
 * archive, removed or dissolved, which no coalition stays through (#278).
 */
export async function keepCarried(
  store: Store,
  groupId: string,
  carried: readonly CarriedCoalition[],
  read: CarriedRead,
): Promise<void> {
  const group = await store.getGroup(groupId);
  if (group === undefined || isArchive(group.archived)) return;
  const candidates = carried.map(({ secret, entries }) => ({
    groupId: deriveCoalitionEntryId(secret),
    log: [...entries],
    outbox: [],
    relayNow: read.relayNow,
  }));
  const reached = coalitionKeys([group], [...(await store.listCoalitions()), ...candidates]);
  for (const coalition of carried) {
    if (reached.has(deriveCoalitionEntryId(coalition.secret))) {
      await keepOne(store, coalition, read);
    }
  }
}

/** Keeps one carried coalition: a new entry with its log, or what an entry here lacks merged in. */
async function keepOne(store: Store, { secret, entries }: CarriedCoalition, read: CarriedRead) {
  const entry = newEntry(secret);
  const made = await store.addGroup(entry).then(
    () => true,
    () => false,
  );
  if (!made) {
    await store.mergeLog(entry.groupId, entries, eventIdOf);
    return;
  }
  const cursor = entries.reduce((high, record) => Math.max(high, record.seq), 0);
  await store.applyPull(entry.groupId, { ...read, records: [...entries], cursor }, eventIdOf);
}

/**
 * Every coalition entry on the device, each with its log folded with the
 * motions its seats decide in the coalitions above it (#122), so a motion
 * opens down every line.
 */
export function foldCoalitions(entries: readonly Group[]): HeldCoalition[] {
  const states = foldTogether(
    entries.map((entry) => ({
      records: entry.log,
      relayNow: entry.relayNow,
      cleared: entry.cleared ?? [],
    })),
  );
  return entries.map((entry, i) => ({ entry, state: states[i] ?? foldGroup(entry) }));
}

/** Every coalition entry on the device, each folded as {@link foldCoalitions} folds it. */
export async function heldCoalitions(store: Pick<Store, 'listCoalitions'>) {
  return foldCoalitions(await store.listCoalitions());
}

/**
 * The motions `state`'s seats decide in each coalition (#100): for each
 * coalition that names a seat the group's reconcile Proposals hold.
 */
export function outsideFor(
  state: Pick<GroupState, 'coalitions'>,
  coalitions: readonly HeldCoalition[],
): Motion[] {
  return coalitions.flatMap(({ state: coalition }) => {
    const seats = coalition.coalition?.seats ?? [];
    const held = state.coalitions.find((c) => seats.some((seat) => seat.key === c.key));
    return held === undefined ? [] : motionsFor(coalition, held.key);
  });
}

/**
 * `group` folded with the motions its seats decide in the coalitions on the
 * device, so its members vote on them as on any of its Proposals (#114).
 */
export function foldWithCoalitions(
  group: Pick<Group, 'log' | 'relayNow' | 'cleared'>,
  coalitions: readonly HeldCoalition[],
): GroupState {
  const own = foldGroup(group);
  const outside = outsideFor(own, coalitions);
  return outside.length === 0 ? own : fold(group.log, group.relayNow, outside, group.cleared ?? []);
}

/**
 * A log on the device that may hold a seat in a coalition, as
 * {@link settleCoalitions} reads it: a group's, or a coalition entry's
 * (#122), folded with the motions it decides from above.
 */
export interface FoldedLog {
  readonly group: Group;
  readonly state: GroupState;
}

/** What one coalition's settling works with. */
interface Settling {
  readonly store: Store;
  readonly entry: Group;
  readonly coalition: GroupState;
  readonly id: string;
  readonly logs: readonly FoldedLog[];
  readonly keys: ReadonlyMap<string, CoalitionKeys>;
  readonly pending: readonly ParsedEvent[];
  readonly ts: number;
}

/** The secret of the seat `seatKey` in this coalition, as a log on this device holds it, or null. */
function seatSecretFor({ keys, entry }: Pick<Settling, 'keys' | 'entry'>, seatKey: string) {
  return keys.get(entry.groupId)?.seats.get(seatKey) ?? null;
}

/** The log on the device whose reconcile Proposals hold `seatKey`, with its fold, or null. */
function holderOf(logs: readonly FoldedLog[], seatKey: string): FoldedLog | null {
  return logs.find(({ state }) => state.coalitions.some((c) => c.key === seatKey)) ?? null;
}

/** Signs `draft`'s body as this entry's participant and queues it. */
async function queue(
  { store, entry, id, ts }: Settling,
  event: { type: 'join' | 'group-result' | 'proposal' | 'room-wrap'; body: object },
): Promise<void> {
  const draft = { ...event, group: id, ts } as Parameters<typeof signEvent>[1];
  await store.enqueue(entry.groupId, signEvent(entry.signingKey, draft).record);
}

/** This entry's participant's seat key in the coalition, or null before they join. */
function boundSeat({ entry, coalition }: Pick<Settling, 'entry' | 'coalition'>): string | null {
  const binding = coalition.coalition?.bindings.find((b) => b.author === entry.me.author);
  return binding?.seat ?? null;
}

/** Whether this entry's participant has a join waiting in the outbox. */
function joinWaits(pending: readonly ParsedEvent[]): boolean {
  return pending.some(({ event }) => event.type === 'join');
}

/**
 * Joins under the planned seat once the coalition names it, with the seat's
 * proof for this entry's key, under the name the plan holds, then drops the
 * plan. The plan names a group on the device, or a coalition entry (#122),
 * whose seat secret came out of its sealed reconcile motion. Returns whether
 * it queued the join.
 */
async function joinIfPlanned(settling: Settling): Promise<boolean> {
  const { entry, coalition, logs, pending } = settling;
  const planned = logs.find(({ group }) => group.groupId === entry.joinAs);
  if (planned === undefined || boundSeat(settling) !== null || joinWaits(pending)) return false;
  const seats = coalition.coalition?.seats ?? [];
  const held = planned.state.coalitions.find((c) => seats.some((s) => s.key === c.key));
  const secret = held === undefined ? null : seatSecretFor(settling, held.key);
  if (held === undefined || secret === null || entry.me.name === '') return false;
  const author = publicKeyOf(entry.signingKey);
  const proof = base64url(signSeatProof(secret, settling.id, author));
  await queue(settling, { type: 'join', body: { name: entry.me.name, seat: held.key, proof } });
  await settling.store.planCoalition(entry.groupId, { joinAs: null });
  return true;
}

/** Whether `body` already waits in the outbox. */
function resultWaits(pending: readonly ParsedEvent[], body: GroupResultBody): boolean {
  return pending.some(
    ({ event }) =>
      event.type === 'group-result' &&
      event.body.motion === body.motion &&
      event.body.seat === body.seat &&
      event.body.result === body.result,
  );
}

/**
 * Queues what the log whose seat this entry's participant is bound to owes
 * the coalition, a group's or a coalition's (#122), folded with the motions
 * it decides, leaving out what already waits. Only its one pass or fail per
 * motion crosses. Returns whether it queued anything.
 */
async function reportResults(settling: Settling) {
  const seat = boundSeat(settling);
  const holder = seat === null ? null : holderOf(settling.logs, seat);
  if (seat === null || holder === null) return false;
  const owed = resultsToReport(holder.state, settling.coalition, seat).filter(
    (body) => !resultWaits(settling.pending, body),
  );
  for (const body of owed) await queue(settling, { type: 'group-result', body });
  return owed.length > 0;
}

/** Whether a promotion record for the Dispatch `id` already waits in the outbox (#126). */
function promotionWaits(pending: readonly ParsedEvent[], id: string): boolean {
  return pending.some(({ event }) => {
    if (event.type !== 'proposal' || !('target' in event.body)) return false;
    const { target } = event.body;
    return target.kind === 'promote' && target.dispatch.id === id;
  });
}

/**
 * Posts the promotion records the log whose seat this entry's participant is
 * bound to owes the coalition (#126; ADR-0037): one for each Dispatch it
 * passed whose ceiling leaves this level, leaving out what already waits.
 * Each carries the Dispatch's id, title and text, its ceiling, the level and
 * the seat, and nothing else. Returns whether it queued anything.
 */
async function promoteDispatches(settling: Settling): Promise<boolean> {
  const seat = boundSeat(settling);
  const holder = seat === null ? null : holderOf(settling.logs, seat);
  if (seat === null || holder === null) return false;
  const owed = promotionsOwed(holder.state, settling.coalition, seat).filter(
    (body) => !promotionWaits(settling.pending, body.target.dispatch.id),
  );
  for (const body of owed) await queue(settling, { type: 'proposal', body });
  return owed.length > 0;
}

/**
 * The seat an admit motion names for `brought`: its name, its public key and,
 * for a coalition (#122), its level and member groups' names, which the
 * ballot shows.
 */
function admitSeatOf(brought: GroupState, key: string) {
  const name = brought.name;
  const info = brought.coalition;
  if (info === null) return { seat: { name, key } };
  const groups = info.seats.map((seat) => seat.name);
  return { seat: { name, key, level: info.level }, groups };
}

/**
 * Once the group or coalition (#122) this device brought a formed
 * coalition's card to has passed its reconcile Proposal, proposes admitting
 * it (#114), with its seat's proof for this entry's key and its seat's
 * X25519 key (#313), and plans to join under its seat; once it didn't pass,
 * drops the plan. Returns whether it queued the motion.
 */
async function proposeAdmission(settling: Settling): Promise<boolean> {
  const { entry, logs, store } = settling;
  const { admitting } = entry;
  const brought = logs.find(({ group }) => group.groupId === admitting?.group);
  const held = brought?.state.coalitions.find((c) => c.proposal === admitting?.proposal);
  if (admitting === undefined || brought === undefined || held === undefined) return false;
  if (held.outcome === 'open') return false;
  const secret = seatSecretFor(settling, held.key);
  if (held.outcome === 'fail' || secret === null) {
    await store.planCoalition(entry.groupId, { admitting: null });
    return false;
  }
  const proof = base64url(signSeatProof(secret, settling.id, publicKeyOf(entry.signingKey)));
  const seat = admitSeatOf(brought.state, held.key);
  const target = { kind: 'admit', ...seat, proof, kx: seatKxOf(secret) };
  const { title, why } = admitting;
  await queue(settling, { type: 'proposal', body: { target, title, why } });
  await store.planCoalition(entry.groupId, { admitting: null, joinAs: admitting.group });
  return true;
}

/**
 * The room `inner` one of a coalition's seats gives this device (#313): the
 * one its reconcile target or motion carried, for a founding seat's, or else
 * the first wrap for it in the coalition's log that its seat secret `seat`
 * opens to the `inner` the genesis commits to (#371), or null. A group's
 * seat and a coalition's seat above (#344) take it alike.
 */
export function seatInner(
  held: { readonly key: string; readonly seat: Uint8Array; readonly inner: Uint8Array | null },
  coalition: Pick<Coalition, 'wraps' | 'commit'>,
  coalitionId: string,
): Uint8Array | null {
  return held.inner ?? unwrapFor(coalition, coalitionId, held.key, held.seat);
}

/** {@link seatInner} for a group's reconcile target that holds one of a coalition's seats (#313). */
export function innerOf(
  target: ReconcileChange,
  coalition: Pick<Coalition, 'wraps' | 'commit'>,
  coalitionId: string,
): Uint8Array | null {
  const inner = target.inner === undefined ? null : fromBase64url(target.inner);
  return seatInner(
    { key: target.key, seat: fromBase64url(target.seat), inner },
    coalition,
    coalitionId,
  );
}

/** Whether a wrap for `seat` already waits in the outbox. */
function wrapWaits(pending: readonly ParsedEvent[], seat: string): boolean {
  return pending.some(({ event }) => event.type === 'room-wrap' && event.body.seat === seat);
}

/**
 * The room `inner` this device holds of the coalition, while a log here holds
 * this entry's bound seat (a group's, or a coalition entry's, #122), with that
 * seat, or null. The device holds `inner` from a founding seat's reconcile
 * Proposal or motion, or from a wrap for one of its admitted seats
 * ({@link coalitionKeys}).
 */
function boundInner(settling: Settling): { seat: string; inner: Uint8Array } | null {
  const seat = boundSeat(settling);
  if (seat === null || holderOf(settling.logs, seat) === null) return null;
  const inner = settling.keys.get(settling.entry.groupId)?.inner ?? null;
  return inner === null ? null : { seat, inner };
}

/**
 * Wraps the room's `inner` to each seat admitted since the genesis (#313)
 * that this entry's participant hasn't wrapped for, in the log or the
 * outbox, when they are bound to another seat whose group, or coalition
 * (#122), here holds `inner`, and it is the one the genesis commits to
 * (#371). Each participant wraps for themselves, whoever else from their
 * seat has: no device can open another's wrap to see whether it holds the
 * room or one its maker made of their own, and an admitted group takes the
 * first that holds the room, so one honest wrap repairs a wrong one. Returns
 * whether it queued any.
 */
async function wrapForAdmitted(settling: Settling): Promise<boolean> {
  const held = boundInner(settling);
  const info = settling.coalition.coalition;
  if (held === null || info === null || info.commit !== roomCommit(held.inner)) return false;
  const { seat, inner } = held;
  const me = settling.entry.me.author;
  const owed = info.admitted.filter(
    (a) =>
      a.key !== seat &&
      !info.wraps.some((w) => w.seat === a.key && w.by === me) &&
      !wrapWaits(settling.pending, a.key),
  );
  for (const { key, kx } of owed) {
    const wrap = wrapInner({ coalitionId: settling.id, seat: key, kx, inner });
    await queue(settling, { type: 'room-wrap', body: { seat: key, wrap } });
  }
  return owed.length > 0;
}

/** The events a record list carries, skipping any that doesn't verify. */
function parsedOf(outbox: readonly Uint8Array[]): ParsedEvent[] {
  return outbox.flatMap((bytes) => {
    const parsed = parseRecord(bytes);
    return parsed === null ? [] : [parsed];
  });
}

/**
 * Every log on the device that may hold a seat: each group that goes on,
 * folded with the motions its seats decide, then each coalition entry,
 * folded with those it decides above (#122).
 */
function foldedLogs(groups: readonly Group[], coalitions: readonly HeldCoalition[]): FoldedLog[] {
  return [
    ...groups.map((group) => ({ group, state: foldWithCoalitions(group, coalitions) })),
    ...coalitions.map(({ entry, state }) => ({ group: entry, state })),
  ];
}

/**
 * Every log on the device that may hold a seat, folded once for a pass's
 * settling: the coalition entries, each folded with the motions it decides
 * above, the groups that go on, and each of those, a group's or a
 * coalition's, folded with what it decides from above (#114, #122). The
 * coalitions' settling and the carried scores (#126, `carry.ts`) both read it.
 */
export interface Holdings {
  readonly entries: readonly Group[];
  readonly coalitions: readonly HeldCoalition[];
  readonly groups: readonly Group[];
  readonly logs: readonly FoldedLog[];
}

/**
 * This device's {@link Holdings}, as the store holds them now. With no
 * coalition on the device there is nothing to settle or carry, so it reads
 * and folds no group, as a pass did before #126.
 */
export async function holdings(
  store: Pick<Store, 'listCoalitions' | 'listGroups'>,
): Promise<Holdings> {
  const entries = await store.listCoalitions();
  if (entries.length === 0) return { entries, coalitions: [], groups: [], logs: [] };
  const coalitions = foldCoalitions(entries);
  const groups = (await store.listGroups()).filter(
    (group) => group.archived === undefined && group.leaving === undefined,
  );
  return { entries, coalitions, groups, logs: foldedLogs(groups, coalitions) };
}

/**
 * Whether this device's member still acts for `log` in the coalitions above
 * it (#377): a coalition entry does (#122); a group does while its member is
 * in it, until a removal of them has passed there (#115). From that final
 * pass they only read, so their device reports no result or promotion
 * record for the group's seat, joins under it, proposes it or wraps the room
 * for it, as once the `remove`, which may fold later, archives the group
 * here. It doesn't ask `can()` for more than reading: a suspension narrows a
 * member to reading too, and the group's seat mustn't fall silent at a
 * steward's word, nor at a participant's step down to Member.
 */
function actsFor({ group, state }: FoldedLog): boolean {
  const me = group.me.author;
  return isCoalitionEntry(group) || (can(state, me, 'read') && !isOusted(state, me));
}

/**
 * After a pass (#114): for each coalition entry whose genesis has arrived,
 * and that hasn't been declined, joins as planned, queues its group's or its
 * coalition's results (#122) and promotion records (#126), proposes a
 * planned admission, and wraps the room's `inner` for each seat admitted
 * since (#313), each only for a log its member still acts for
 * ({@link actsFor}). Returns the ids of the entries that queued anything,
 * for the loop to send at once. `clock` is the device clock in ms, for each
 * event's display-only `ts`. `held` is what {@link holdings} read, when the
 * loop has read it already.
 */
export async function settleCoalitions(
  store: Store,
  clock: () => number,
  held?: Holdings,
): Promise<string[]> {
  const { entries, coalitions, groups, logs: all } = held ?? (await holdings(store));
  if (entries.length === 0) return [];
  const keys = coalitionKeys(groups, entries);
  const logs = all.filter(actsFor);
  const queued: string[] = [];
  for (const { entry, state: coalition } of coalitions) {
    const id = coalition.group;
    if (id === null || coalition.coalition?.status === 'declined') continue;
    const pending = parsedOf(entry.outbox);
    const settling = { store, entry, coalition, id, logs, keys, pending, ts: clock() };
    const steps = [
      joinIfPlanned,
      reportResults,
      promoteDispatches,
      proposeAdmission,
      wrapForAdmitted,
    ];
    let any = false;
    for (const step of steps) any = (await step(settling)) || any;
    if (any) queued.push(entry.groupId);
  }
  return queued;
}

/** Whether the sync loop reads `entry`: any group, and a coalition until it was declined. */
export function stillSyncs(entry: Group): boolean {
  if (!isCoalitionEntry(entry)) return true;
  return foldGroup(entry).coalition?.status !== 'declined';
}
