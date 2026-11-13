/**
 * Recovery contacts (#109; ADR-0043 §1, ADR-0008, ADR-0009, ADR-0074,
 * ADR-0075 §4): the people someone trusts to help them back in after every
 * device is lost.
 *
 * - **Choosing.** {@link chooseContacts} takes `t` and the contacts the
 *   picker offered ({@link contactGroups}: current members of the person's
 *   groups, never themselves nor anyone a removal has passed against, by
 *   their name in that group). It starts the relay backup
 *   (`startRelayBackup`, #97), since a backup nobody else can unlock helps
 *   no one, splits its key `t` of `n` (`crypto/shares.ts`),
 *   and queues one `recovery-share` per contact in the group they share,
 *   sealed to their per-group encryption key (#98). The event names no one,
 *   so the group sees only an opaque box from the person. A contact picked
 *   in two groups gets a share in each, and can then tell both names are the
 *   same person, as the picker says (ADR-0075 §4).
 * - **Choosing again.** Every choice makes a new backup key (#272): a later
 *   one, the first on a device recovered with contacts (#118), and the first
 *   on a device whose key came from a backup file (#78) or a link (#96),
 *   which other copies of the file, or the other device, hold too. So the
 *   relay copy moves to a new id. It sends the new shares, then overwrites
 *   the old id with 65,536 random bytes, so every older share, a dropped
 *   contact's included, rebuilds only a key whose backup is gone.
 * - **Keeping it gone (#272).** The plan's `retired` list keeps every id a
 *   choice here replaced, and {@link retireOldBackups} reads each once a
 *   relay day, after a complete sync pass: a backup there again, as another
 *   device's upload that landed just after the overwrite, or nothing, as
 *   once the relay forgets an id after 180 days, gets random bytes again.
 *   Any other device of the person's that still holds a replaced key finds
 *   those bytes before its next upload and stops (`relayBackup.ts`), so the
 *   latest choice wins on every device, and a device whose plan a later
 *   choice elsewhere replaced marks it superseded.
 * - **The list stays here.** The plan (`RecoveryPlan`) lives in the store's
 *   device record, and no backup file, link bundle or relay copy carries it.
 *   Nothing about the choice leaves the device but the sealed shares, and,
 *   beside the backup key in a backup file or a link bundle, the split's
 *   random id (#272), which every contact's share already names.
 * - **Holding.** Each device tries every `recovery-share` in its groups
 *   against its own encryption key there, and keeps the latest that opens per
 *   (group, person) while both are in the group ({@link heldShares}). It
 *   shows only whose share it holds, and where. #118 reads the share itself
 *   with {@link openHeldShare}. It tries each box once a page, keeping only
 *   whether it opened, and forgets that of a group once the group no longer
 *   goes on here (#276).
 *
 * A group counts here only while it goes on for this device: its genesis is
 * back, it hasn't dissolved (#108) or turned read-only, this device isn't
 * leaving it (#77), and this membership is still in it. Choosing and
 * holding both read the device's keys, so on a device locked with a passkey
 * (#95) they wait behind the unlock screen: the store refuses those reads
 * with `VaultLocked` until it opens.
 */
import { fromBase64url } from '../crypto/base64url';
import { isAllowedThreshold } from '../crypto/recoveryPolicy';
import { isRelayBackupBlob, newScrubBlob } from '../crypto/relayBackup';
import { newSplitId, openShare, type RecoveryShare, sealShare, splitKey } from '../crypto/shares';
import { can, isOusted } from '../engine/capabilities';
import { signEvent } from '../engine/event';
import type { GroupState, SealedShare } from '../engine/fold';
import { displayName } from '../engine/names';
import type { Relay } from '../net/relay';
import type { ChosenContact, Group, RecoveryPlan, Store } from './db';
import { foldGroup } from './expiry';
import { refreshRelayBackup, type RelayBackupServices, startRelayBackup } from './relayBackup';
import type { Sync } from './sync';

/** One person the picker offers: their key and their name in the group. */
export interface ContactOption {
  readonly member: string;
  readonly name: string;
}

/** One group the picker lists, with the people in it a share can go to. */
export interface ContactGroup {
  readonly groupId: string;
  readonly name: string;
  readonly members: readonly ContactOption[];
}

/** One contact the person picked: who, in which group. */
export interface ContactChoice {
  readonly groupId: string;
  readonly member: string;
}

/** What the person chose: `t` needed of the contacts picked. */
export interface RecoveryChoice {
  readonly t: number;
  readonly contacts: readonly ContactChoice[];
}

/** What choosing works with: the relay backup's services, the device's groups, and the sync loop. */
export interface RecoveryServices extends RelayBackupServices {
  readonly store: RelayBackupServices['store'] &
    RetireServices['store'] &
    Pick<Store, 'listGroups' | 'getGroup' | 'enqueueAll' | 'setRecoveryPlan'>;
  readonly relay: RelayBackupServices['relay'];
  /** The sync loop, run once so the new shares go before the old backup is overwritten. */
  readonly sync: Pick<Sync, 'syncOnce'>;
}

/** What keeping the retired backup ids overwritten works with: the plan, the groups' relay day, and the relay. */
export interface RetireServices {
  readonly store: Pick<Store, 'getRecoveryPlan' | 'markRetiredChecked' | 'listGroups'>;
  readonly relay: Pick<Relay, 'putBackup' | 'getBackup'>;
}

/** One contact as Settings shows them: as chosen, and whether they still share a group with the person. */
export interface ContactStatus extends ChosenContact {
  readonly shared: boolean;
}

/** Where the person's recovery contacts stand. */
export interface RecoveryStatus {
  readonly t: number;
  readonly n: number;
  readonly contacts: readonly ContactStatus[];
  /** True once fewer than `t` contacts still share a group with the person: time to choose again. */
  readonly chooseAgain: boolean;
  /**
   * True once a later choice on another of the person's devices retired the
   * plan's key (#272): these contacts' shares rebuild a key whose backup is
   * gone, so it's time to choose again here, or keep the other device's.
   */
  readonly superseded: boolean;
}

/** One share this device holds, as Settings and group home show it: whose, and where. */
export interface HeldShare {
  /** The `recovery-share` event's id. */
  readonly id: string;
  readonly groupId: string;
  readonly groupName: string;
  /** The person's key in the group. */
  readonly author: string;
  /** The person's name in the group. */
  readonly name: string;
}

/** A person the picker offers, with the key their share is sealed to. */
interface Offer extends ContactOption {
  readonly kx: string;
}

/** A group the picker lists, with its offers. */
interface OfferGroup {
  readonly groupId: string;
  readonly name: string;
  readonly members: readonly Offer[];
}

/** One picked contact, ready to seal to: as chosen, with their encryption key. */
interface Sealable extends ChosenContact {
  readonly kx: string;
}

/**
 * The group's state when it goes on for this device and this member is still
 * in it, or null: genesis not back, dissolved (#108), read-only, leaving
 * (#77), or this membership gone, as when it left on another device.
 * `folded` is the group's log already folded as `foldGroup` folds it (#111:
 * at its `relayNow`, with its cleared Proposals), when the caller has it, so
 * it isn't folded twice.
 */
function liveState(group: Group, folded?: GroupState): GroupState | null {
  if (group.archived !== undefined || group.leaving !== undefined) return null;
  const state = folded ?? foldGroup(group);
  const present = state.members.some((m) => m.author === group.me.author);
  return state.group === null || state.dissolved !== null || !present ? null : state;
}

/**
 * One group's offers: every other current member with an encryption key, by
 * their name there, but no one a removal has passed against, though its
 * `remove` hasn't landed yet (#360). None at all once one has passed against
 * this member, who may then only read (`can`, #115).
 */
function offersIn(group: Group): OfferGroup | null {
  const state = liveState(group);
  if (state === null || !can(state, group.me.author, 'see-roster')) return null;
  const members = state.members.flatMap(({ author, kx }) =>
    author === group.me.author || kx === null || isOusted(state, author)
      ? []
      : [{ member: author, name: displayName(state, author) ?? '', kx }],
  );
  return members.length === 0 ? null : { groupId: group.groupId, name: state.name, members };
}

/**
 * The groups the picker lists, in the store's order: each where this member
 * may see the roster, with every other current member a share can be sealed
 * to (one with a `kx`, #98), by their name there, leaving out anyone a
 * removal has passed against (#360). A group with no one to pick is left out.
 */
export function contactGroups(groups: readonly Group[]): ContactGroup[] {
  return groups.flatMap((group) => {
    const offers = offersIn(group);
    if (offers === null) return [];
    const members = offers.members.map(({ member, name }) => ({ member, name }));
    return [{ groupId: offers.groupId, name: offers.name, members }];
  });
}

/**
 * The choice's contacts as the picker offers them, or a thrown error for any
 * the picker never offers: yourself, a stranger, a group that doesn't go on,
 * the same person twice, or a threshold outside 2 of 3 to 5 of 7.
 */
function checked(groups: readonly Group[], { t, contacts }: RecoveryChoice): Sealable[] {
  if (!isAllowedThreshold(t, contacts.length)) {
    throw new RangeError('Recovery takes from 2 of 3 to 5 of 7 contacts.');
  }
  const offered = groups.flatMap((group) => offersIn(group) ?? []);
  const picked = contacts.map(({ groupId, member }) => {
    const where = offered.find((option) => option.groupId === groupId);
    const who = where?.members.find((option) => option.member === member);
    if (where === undefined || who === undefined) {
      throw new Error('That person can’t hold a recovery share.');
    }
    return { groupId, member, name: who.name, groupName: where.name, kx: who.kx };
  });
  const distinct = new Set(picked.map(({ groupId, member }) => `${groupId} ${member}`));
  if (distinct.size !== picked.length) throw new Error('Each contact can be picked once.');
  return picked;
}

/** The backup key `startRelayBackup` kept: the one to split. */
async function backupKey(store: RecoveryServices['store']): Promise<Uint8Array> {
  const state = await store.getRelayBackup();
  if (state === undefined) throw new Error('The relay backup has no key.');
  return state.key;
}

/**
 * Each picked contact's signed `recovery-share`, grouped by the group it goes
 * to, in the order picked: one share each, sealed to their encryption key.
 */
async function signedShares(
  services: RecoveryServices,
  picked: readonly Sealable[],
  shares: readonly Uint8Array[],
  { split, t }: Pick<RecoveryShare, 'split' | 't'>,
): Promise<Map<string, Uint8Array[]>> {
  const n = picked.length;
  const byGroup = new Map<string, Uint8Array[]>();
  for (const [i, contact] of picked.entries()) {
    const group = await services.store.getGroup(contact.groupId);
    if (group === undefined) throw new Error('No such group on this device.');
    const place = { groupId: contact.groupId, contact: contact.member, author: group.me.author };
    const share = shares[i] ?? new Uint8Array();
    const box = sealShare({ ...place, kx: fromBase64url(contact.kx) }, { split, t, n, share });
    const body = { box };
    const ts = services.now();
    const records = byGroup.get(contact.groupId) ?? [];
    records.push(
      signEvent(group.signingKey, { type: 'recovery-share', group: contact.groupId, ts, body })
        .record,
    );
    byGroup.set(contact.groupId, records);
  }
  return byGroup;
}

/**
 * Chooses the person's recovery contacts (#109): `t` needed of the contacts
 * picked, each from {@link contactGroups}.
 *
 * It awaits the relay backup's start with a new key, always (#272): whatever
 * key the device held, its own earlier choice's, a recovered one (#118), or
 * one a backup file or a link brought, someone else could still rebuild or
 * hold it. It keeps the split's id beside the key, splits the key, queues
 * each contact's sealed share in their group, keeps the plan, runs the sync
 * loop once so the shares go, and then overwrites the replaced key's relay
 * backup ({@link retireOldBackups}).
 *
 * @throws {RangeError | Error} for a choice the picker never offers, before
 *   anything is made, kept or queued.
 */
export async function chooseContacts(
  services: RecoveryServices,
  choice: RecoveryChoice,
): Promise<void> {
  const { store } = services;
  const picked = checked(await store.listGroups(), choice);
  const held = await store.getRecoveryPlan();
  const split = newSplitId();
  const replaced = await startRelayBackup(services, { newKey: true, split });
  const shares = await splitKey(await backupKey(store), picked.length, choice.t);
  try {
    const byGroup = await signedShares(services, picked, shares, { split, t: choice.t });
    for (const [groupId, records] of byGroup) await store.enqueueAll(groupId, records);
  } finally {
    for (const share of shares) share.fill(0);
  }
  const contacts = picked.map(({ groupId, member, name, groupName }) => ({
    groupId,
    member,
    name,
    groupName,
  }));
  const retired = [...(held?.retired ?? []), ...(replaced === null ? [] : [replaced])];
  const plan: RecoveryPlan = {
    split,
    t: choice.t,
    n: picked.length,
    contacts,
    chosenAt: services.now(),
    retired,
  };
  await store.setRecoveryPlan(plan);
  await services.sync.syncOnce();
  await retireOldBackups(services, { now: true });
}

/** Minutes in a UTC day: a relay minute's day is ⌊minute / 1,440⌋. */
const DAY_MINUTES = 1440;

/** When to read the retired ids: now, as a choice does, or once a relay day, as each sync pass does. */
export interface RetireOptions {
  readonly now?: boolean;
}

/**
 * Keeps every relay backup id the plan retired overwritten with 65,536
 * random bytes (#272): reads each from the relay, and puts fresh random bytes
 * under one that holds a backup again or nothing, leaving one that already
 * holds random bytes. After a sync pass it runs once a relay day, by the
 * latest `relayNow` among the device's groups, and notes the day once every
 * id checked out; one the relay couldn't read or take, offline say, leaves
 * the day unchecked, so the next complete pass tries again. A choice runs it
 * at once (`now`), whatever the day.
 */
export async function retireOldBackups(
  services: RetireServices,
  { now = false }: RetireOptions = {},
): Promise<void> {
  const plan = await services.store.getRecoveryPlan();
  if (plan === undefined || plan.retired.length === 0) return;
  const day = relayDayOf(await services.store.listGroups());
  if (!now && !isDue(plan, day)) return;
  const kept = await keepAllOverwritten(services.relay, plan.retired);
  if (kept && day !== null) await services.store.markRetiredChecked(day);
}

/** Keeps each of `ids` overwritten, in turn; true once every one checked out. */
async function keepAllOverwritten(
  relay: RetireServices['relay'],
  ids: readonly string[],
): Promise<boolean> {
  let kept = true;
  for (const id of ids) kept = (await keepOverwritten(relay, id)) && kept;
  return kept;
}

/** Whether relay day `day` is a later one than the last the plan's retired ids were checked on. */
function isDue({ retiredCheckedDay }: RecoveryPlan, day: number | null): day is number {
  return day !== null && (retiredCheckedDay === undefined || day > retiredCheckedDay);
}

/**
 * Reads the retired id `id`, and puts fresh random bytes there unless it
 * already holds some; true once it does, false when the relay couldn't be
 * read or didn't take them.
 */
async function keepOverwritten(relay: RetireServices['relay'], id: string): Promise<boolean> {
  const blob = await relay.getBackup(id).catch(() => undefined);
  if (blob === undefined) return false;
  if (blob !== null && !isRelayBackupBlob(blob)) return true;
  return relay.putBackup(id, newScrubBlob()).then(
    () => true,
    () => false,
  );
}

/** The relay's UTC day by the latest `relayNow` among `groups`, or null before any synced. */
function relayDayOf(groups: readonly Pick<Group, 'relayNow'>[]): number | null {
  const latest = Math.max(...groups.map((group) => group.relayNow ?? -1));
  return latest < 0 ? null : Math.floor(latest / DAY_MINUTES);
}

/**
 * What the app runs after each complete sync pass (`createSync`'s
 * `afterPass`): first it forgets the share verdicts of each group no longer
 * on the device as one it goes on in (#276), then the relay backup's daily
 * refresh (#97), then the overwrite of any backup id an earlier choice
 * retired (#109).
 */
export async function afterSyncPass(
  services: RelayBackupServices & { readonly store: RetireServices['store'] },
): Promise<void> {
  // First, from the store alone, so a refresh that fails still lets a gone group's verdicts go.
  await services.store.listGroups().then(forgetGoneVerdicts, () => undefined);
  await refreshRelayBackup(services);
  await retireOldBackups(services);
}

/**
 * Where the person's contacts stand (#109): each one as chosen, and whether
 * they are still a current member of a group that goes on for this device,
 * and whether so few are left that it's time to choose again. Null while
 * this device keeps no plan.
 */
export function recoveryStatus(
  plan: RecoveryPlan | undefined,
  groups: readonly Group[],
): RecoveryStatus | null {
  if (plan === undefined) return null;
  const contacts = plan.contacts.map((contact) => {
    const group = groups.find(({ groupId }) => groupId === contact.groupId);
    const state = group === undefined ? null : liveState(group);
    const shared = state?.members.some((m) => m.author === contact.member) === true;
    return { ...contact, shared };
  });
  const left = contacts.filter(({ shared }) => shared).length;
  const superseded = plan.supersededAt !== undefined;
  return { t: plan.t, n: plan.n, contacts, chooseAgain: superseded || left < plan.t, superseded };
}

/**
 * The verdicts of shares this page has tried, by membership (member and
 * group), then event id: whether each opened for that member. They hold no
 * share, only whether one opened, so a store change doesn't open every box
 * again. A membership's go once its group no longer goes on here
 * ({@link forgetGoneVerdicts}, #276), so the map never outgrows the groups
 * on the device.
 */
const verdicts = new Map<string, Map<string, boolean>>();

/** The key {@link verdicts} keeps `group`'s membership under. */
function membershipOf(group: Pick<Group, 'groupId' | 'me'>): string {
  return `${group.me.author} ${group.groupId}`;
}

/**
 * Forgets the verdicts of every membership but those of `groups`, the
 * device's groups, that it may still hold shares in (#276). A group it left,
 * which is gone from the store, and one it is leaving or keeps read-only (a
 * removal or a dissolve, #108, #115), whose shares it never reads again,
 * take theirs with them. The sync loop's `afterPass` runs it after every
 * complete pass ({@link afterSyncPass}), so however a group went, its
 * verdicts go by the next one.
 */
export function forgetGoneVerdicts(groups: readonly Group[]): void {
  const live = groups.filter(
    (group) => group.leaving === undefined && group.archived === undefined,
  );
  const kept = new Set(live.map(membershipOf));
  for (const key of verdicts.keys()) if (!kept.has(key)) verdicts.delete(key);
}

/** Whether `posted` opens for this device's membership of `group`, trying it once per page. */
function opensHere(group: Group, posted: SealedShare, kxKey: Uint8Array): boolean {
  const key = membershipOf(group);
  const tried = verdicts.get(key) ?? new Map<string, boolean>();
  verdicts.set(key, tried);
  const known = tried.get(posted.id);
  if (known !== undefined) return known;
  const share = openShareFrom(group, posted, kxKey);
  share?.share.fill(0);
  tried.set(posted.id, share !== null);
  return share !== null;
}

/** The share in `posted`, sealed to this device's membership of `group`, or null. */
function openShareFrom(group: Group, posted: SealedShare, kxKey: Uint8Array): RecoveryShare | null {
  const place = { groupId: group.groupId, contact: group.me.author, author: posted.by };
  return openShare({ ...place, kxKey, box: posted.box });
}

/**
 * The latest share sealed to this device's membership in `group` from each
 * other current member, in the relay order of those latest shares, with the
 * group's state; nothing for a group that doesn't go on, or with no key.
 */
function latestHeld(
  group: Group,
  folded?: GroupState,
): { state: GroupState; held: SealedShare[] } | null {
  const state = liveState(group, folded);
  const { kxKey } = group;
  if (state === null || kxKey === undefined) return null;
  const latest = new Map<string, SealedShare>();
  for (const posted of state.recoveryShares) {
    const current = state.members.some((m) => m.author === posted.by);
    if (posted.by === group.me.author || !current || !opensHere(group, posted, kxKey)) continue;
    latest.delete(posted.by);
    latest.set(posted.by, posted);
  }
  return { state, held: [...latest.values()] };
}

/**
 * The shares this device holds in `group`, as group home shows them. Pass
 * `folded`, the group's log folded at its `relayNow`, when it's at hand.
 */
export function heldSharesIn(group: Group, folded?: GroupState): HeldShare[] {
  const found = latestHeld(group, folded);
  if (found === null) return [];
  const { state, held } = found;
  return held.map(({ id, by }) => ({
    id,
    groupId: group.groupId,
    groupName: state.name,
    author: by,
    name: displayName(state, by) ?? '',
  }));
}

/** Every share this device holds, group by group in the store's order, as Settings lists them. */
export function heldShares(groups: readonly Group[]): HeldShare[] {
  return groups.flatMap((group) => heldSharesIn(group));
}

/**
 * The share this device holds for `author` in `group` (#118 hands it back):
 * the latest that opens for this membership, while both are in the group,
 * or null.
 */
export function openHeldShare(group: Group, author: string): RecoveryShare | null {
  const { kxKey } = group;
  const posted = latestHeld(group)?.held.find(({ by }) => by === author);
  return posted === undefined || kxKey === undefined ? null : openShareFrom(group, posted, kxKey);
}
