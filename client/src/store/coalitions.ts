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
 * - a device that brought a formed coalition's card to a group proposes
 *   admitting it once that group's reconcile Proposal has passed, and plans
 *   to join under its seat; if it didn't pass, the plan goes.
 *
 * A group's own fold takes the motions its seats decide (`motionsFor`), so
 * its members vote on them as on any Proposal ({@link foldGroup}). Nothing
 * here reads a person's key in one log to find them in another.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { deriveCoalitionEntryId } from '../crypto/card';
import { signSeatProof } from '../crypto/seat';
import { newSigningKeys, publicKeyOf } from '../crypto/sign';
import type { Motion } from '../engine/coalition';
import { motionsFor, resultsToReport } from '../engine/crossing';
import { type GroupResultBody, type ParsedEvent, parseRecord, signEvent } from '../engine/event';
import { fold, type GroupState } from '../engine/fold';
import { type Group, isCoalitionEntry, type NewGroup, type Store } from './db';

/** A coalition entry with its log folded. */
export interface HeldCoalition {
  readonly entry: Group;
  readonly state: GroupState;
}

/** The coalition secrets `state` holds, in base64url: each of its reconcile Proposals'. */
export function heldSecrets(state: Pick<GroupState, 'proposals'>): string[] {
  return state.proposals.flatMap((p) => (p.target.kind === 'reconcile' ? [p.target.secret] : []));
}

/** The coalition secrets the reconcile Proposals in `group`'s outbox carry, in base64url. */
export function queuedSecrets(group: Pick<Group, 'outbox'>): string[] {
  return group.outbox.flatMap((bytes) => {
    const event = parseRecord(bytes)?.event;
    if (event?.type !== 'proposal' || !('target' in event.body)) return [];
    return event.body.target.kind === 'reconcile' ? [event.body.target.secret] : [];
  });
}

/**
 * A new entry for the coalition whose secret is `secret` (#114): a fresh
 * signing key for this coalition alone, no name yet, and `plan`.
 */
export function newEntry(
  secret: Uint8Array,
  plan: Pick<NewGroup, 'joinAs' | 'admitting'> & { readonly name?: string } = {},
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

/**
 * Keeps an entry for each coalition secret a group on the device holds, in
 * its log or its outbox, that has none yet. Another tab may make the same
 * entry first: then the device keeps that one.
 */
export async function ensureEntries(store: Store): Promise<void> {
  const held = new Set((await store.listCoalitions()).map((entry) => entry.groupId));
  for (const group of await store.listGroups()) {
    const secrets = [...heldSecrets(fold(group.log, group.relayNow)), ...queuedSecrets(group)];
    for (const secret of secrets) {
      const entry = newEntry(fromBase64url(secret));
      if (held.has(entry.groupId)) continue;
      held.add(entry.groupId);
      await store.addGroup(entry).catch(() => undefined);
    }
  }
}

/** Every coalition entry on the device, each with its log folded. */
export async function heldCoalitions(store: Pick<Store, 'listCoalitions'>) {
  return (await store.listCoalitions()).map((entry) => ({
    entry,
    state: fold(entry.log, entry.relayNow),
  }));
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
export function foldGroup(
  group: Pick<Group, 'log' | 'relayNow'>,
  coalitions: readonly HeldCoalition[],
): GroupState {
  const own = fold(group.log, group.relayNow);
  const outside = outsideFor(own, coalitions);
  return outside.length === 0 ? own : fold(group.log, group.relayNow, outside);
}

/** A group on the device with its fold, as {@link settleCoalitions} reads it. */
interface FoldedGroup {
  readonly group: Group;
  readonly state: GroupState;
}

/** The seat secret, in bytes, of `seatKey`'s reconcile Proposal in `state`, or null. */
function seatSecretIn(state: GroupState, seatKey: string): Uint8Array | null {
  for (const p of state.proposals) {
    if (p.target.kind === 'reconcile' && p.target.key === seatKey) {
      return fromBase64url(p.target.seat);
    }
  }
  return null;
}

/** The group on the device whose reconcile Proposals hold `seatKey`, with its fold, or null. */
function holderOf(groups: readonly FoldedGroup[], seatKey: string): FoldedGroup | null {
  return groups.find(({ state }) => state.coalitions.some((c) => c.key === seatKey)) ?? null;
}

/** What one coalition's settling works with. */
interface Settling {
  readonly store: Store;
  readonly entry: Group;
  readonly coalition: GroupState;
  readonly id: string;
  readonly groups: readonly FoldedGroup[];
  readonly pending: readonly ParsedEvent[];
  readonly ts: number;
}

/** Signs `draft`'s body as this entry's participant and queues it. */
async function queue(
  { store, entry, id, ts }: Settling,
  event: { type: 'join' | 'group-result' | 'proposal'; body: object },
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
 * Joins under the planned group's seat once the coalition names it, with the
 * seat's proof for this entry's key, under the name the plan holds, then
 * drops the plan. Returns whether it queued the join.
 */
async function joinIfPlanned(settling: Settling): Promise<boolean> {
  const { entry, coalition, groups, pending } = settling;
  const planned = groups.find(({ group }) => group.groupId === entry.joinAs);
  if (planned === undefined || boundSeat(settling) !== null || joinWaits(pending)) return false;
  const seats = coalition.coalition?.seats ?? [];
  const held = planned.state.coalitions.find((c) => seats.some((s) => s.key === c.key));
  const secret = held === undefined ? null : seatSecretIn(planned.state, held.key);
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
 * Queues what the group whose seat this entry's participant is bound to owes
 * the coalition, folded with the motions its seat decides, leaving out what
 * already waits. Returns whether it queued anything.
 */
async function reportResults(settling: Settling, coalitions: readonly HeldCoalition[]) {
  const seat = boundSeat(settling);
  const holder = seat === null ? null : holderOf(settling.groups, seat);
  if (seat === null || holder === null) return false;
  const state = foldGroup(holder.group, coalitions);
  const owed = resultsToReport(state, settling.coalition, seat).filter(
    (body) => !resultWaits(settling.pending, body),
  );
  for (const body of owed) await queue(settling, { type: 'group-result', body });
  return owed.length > 0;
}

/**
 * Once the group this device brought a formed coalition's card to has
 * passed its reconcile Proposal, proposes admitting it (#114), with its
 * seat's proof for this entry's key, and plans to join under its seat; once
 * it didn't pass, drops the plan. Returns whether it queued the motion.
 */
async function proposeAdmission(settling: Settling): Promise<boolean> {
  const { entry, groups, store } = settling;
  const { admitting } = entry;
  const brought = groups.find(({ group }) => group.groupId === admitting?.group);
  const held = brought?.state.coalitions.find((c) => c.proposal === admitting?.proposal);
  if (admitting === undefined || brought === undefined || held === undefined) return false;
  if (held.outcome === 'open') return false;
  const secret = seatSecretIn(brought.state, held.key);
  if (held.outcome === 'fail' || secret === null) {
    await store.planCoalition(entry.groupId, { admitting: null });
    return false;
  }
  const proof = base64url(signSeatProof(secret, settling.id, publicKeyOf(entry.signingKey)));
  const target = { kind: 'admit', seat: { name: brought.state.name, key: held.key }, proof };
  const { title, why } = admitting;
  await queue(settling, { type: 'proposal', body: { target, title, why } });
  await store.planCoalition(entry.groupId, { admitting: null, joinAs: admitting.group });
  return true;
}

/** The events a record list carries, skipping any that doesn't verify. */
function parsedOf(outbox: readonly Uint8Array[]): ParsedEvent[] {
  return outbox.flatMap((bytes) => {
    const parsed = parseRecord(bytes);
    return parsed === null ? [] : [parsed];
  });
}

/**
 * After a pass (#114): for each coalition entry whose genesis has arrived,
 * and that hasn't been declined, joins as planned, queues its group's
 * results, and proposes a planned admission. Returns the ids of the entries
 * that queued anything, for the loop to send at once. `clock` is the device
 * clock in ms, for each event's display-only `ts`.
 */
export async function settleCoalitions(store: Store, clock: () => number): Promise<string[]> {
  const coalitions = await heldCoalitions(store);
  const groups = (await store.listGroups())
    .filter((group) => group.archived === undefined && group.leaving === undefined)
    .map((group) => ({ group, state: fold(group.log, group.relayNow) }));
  const queued: string[] = [];
  for (const { entry, state: coalition } of coalitions) {
    const id = coalition.group;
    if (id === null || coalition.coalition?.status === 'declined') continue;
    const settling = {
      store,
      entry,
      coalition,
      id,
      groups,
      pending: parsedOf(entry.outbox),
      ts: clock(),
    };
    const joined = await joinIfPlanned(settling);
    const reported = await reportResults(settling, coalitions);
    const admitted = await proposeAdmission(settling);
    if (joined || reported || admitted) queued.push(entry.groupId);
  }
  return queued;
}

/** Whether the sync loop reads `entry`: any group, and a coalition until it was declined. */
export function stillSyncs(entry: Group): boolean {
  if (!isCoalitionEntry(entry)) return true;
  return fold(entry.log, entry.relayNow).coalition?.status !== 'declined';
}
