/**
 * Recovering with contacts (#118) across real devices, for tests: Ana's
 * group with her contacts chosen, on one fake relay, through the app's own
 * Create group, Join and Choose recovery contacts, and a relay whose GETs a
 * test can turn off while its PUTs still go through.
 */
import { joinGroup, lookupInvite, makeInvite } from '../app/actions';
import { parseInviteLink } from '../app/invite';
import { fromBase64url } from '../crypto/base64url';
import { deriveWeekMailboxId, weekOf } from '../crypto/groupKeys';
import { openRelease, recoveryChannel, type Release } from '../crypto/recovery';
import { xchachaSeal } from '../crypto/seal';
import { LEVELS } from '../engine/capabilities';
import type { Group } from '../store/db';
import { chooseContacts } from '../store/recovery';
import type { TestDevice } from './appServices';
import type { FakeRelay } from './fakeRelay';
import { foundAnother, members } from './members';

/** The level joiners join at: the creating level, as `members.ts` joins them. */
const [, , CREATING] = LEVELS;

/** Minutes a contact holds a share after the relay receives their alert. */
export const HOLD = 4320;

/** What a gated relay refuses: every GET while `gets` is false, and any GET naming a `blocked` mailbox. */
export interface Gate {
  gets: boolean;
  blocked: readonly string[];
}

/** A fake relay, and a view of it whose GETs fail as its gate says, while PUTs still go. */
export interface GatedRelay {
  /** What devices talk to. */
  readonly view: FakeRelay;
  readonly gate: Gate;
}

/** Whether `gate` refuses the request to `input`. */
function refuses(gate: Gate, input: RequestInfo | URL, init?: RequestInit): boolean {
  if ((init?.method ?? 'GET') !== 'GET') return false;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return !gate.gets || gate.blocked.some((mailbox) => url.includes(mailbox));
}

/** `fake` behind a gate on its GETs. */
export function gated(fake: FakeRelay): GatedRelay {
  const gate: Gate = { gets: true, blocked: [] };
  const view = Object.create(fake) as FakeRelay;
  Object.defineProperty(view, 'fetch', {
    value: (input: RequestInfo | URL, init?: RequestInit) =>
      refuses(gate, input, init)
        ? Promise.reject(new TypeError('Failed to fetch'))
        : fake.fetch(input, init),
  });
  return { view, gate };
}

/** Every weekly mailbox id of `group`'s secret from a week before `minute` to a week after (#110). */
export function mailboxesAround(group: Group, minute: number): string[] {
  const week = weekOf(minute);
  return [week - 1, week, week + 1].map((each) => deriveWeekMailboxId(group.secret, each));
}

/** The group `groupId` on `device`. */
export async function groupOn(device: TestDevice, groupId: string): Promise<Group> {
  const kept = await device.services.store.getGroup(groupId);
  if (kept === undefined) throw new Error('Expected the group on the device.');
  return kept;
}

/** The member key of `device` in `groupId`. */
export async function keyOf(device: TestDevice, groupId: string): Promise<string> {
  return (await groupOn(device, groupId)).me.author;
}

/** Syncs every device twice, each in turn, so each sees what the others sent. */
export async function syncAll(devices: readonly TestDevice[]): Promise<void> {
  for (const device of devices) await device.services.sync.syncOnce();
  for (const device of devices) await device.services.sync.syncOnce();
}

/** `device` joins `groupId` as `name` from an invite `founder` makes, and syncs. */
export async function joinWith(
  founder: TestDevice,
  groupId: string,
  device: TestDevice,
  name: string,
): Promise<void> {
  const seed = parseInviteLink(
    await makeInvite(founder.services, groupId, founder.services.origin),
  );
  if (seed === null) throw new Error('Expected an invite link.');
  const found = await lookupInvite(device.services, seed);
  if (found.kind !== 'found') throw new Error('Expected the invite to open.');
  await joinGroup(device.services, found.group, name, CREATING);
  await device.services.sync.syncOnce();
}

/** Ana's world: Riverside Tenants with Ben, Cal and Dee, and Allotment with Cal. */
export interface RecoveryWorld {
  readonly ana: TestDevice;
  readonly ben: TestDevice;
  readonly cal: TestDevice;
  readonly dee: TestDevice;
  readonly devices: readonly TestDevice[];
  /** Riverside Tenants. */
  readonly groupId: string;
  /** Allotment, which Ana founded and Cal joined. */
  readonly allotment: string;
}

/**
 * Ana founds Riverside Tenants, which Ben, Cal and Dee join, and Allotment,
 * which Cal joins; she picks Ben (Riverside), Cal (Allotment) and Dee
 * (Riverside) at 2 of 3, and every device syncs, so each contact holds a share.
 */
export async function recoveryWorld(fake: FakeRelay): Promise<RecoveryWorld> {
  const made = await members(fake, ['Ana', 'Ben', 'Cal', 'Dee']);
  const [ana, ben, cal, dee] = made.devices;
  if (!ana || !ben || !cal || !dee) throw new Error('Expected four devices.');
  const allotment = await foundAnother(ana, 'Ana');
  await joinWith(ana, allotment, cal, 'Cal');
  const { groupId } = made;
  const devices = [ana, ben, cal, dee];
  await syncAll(devices);
  const contact = async (device: TestDevice, where: string) => ({
    groupId: where,
    member: await keyOf(device, where),
  });
  await chooseContacts(ana.services, {
    t: 2,
    contacts: [
      await contact(ben, groupId),
      await contact(cal, allotment),
      await contact(dee, groupId),
    ],
  });
  await syncAll(devices);
  return { ana, ben, cal, dee, devices, groupId, allotment };
}

/**
 * Every release the request mailbox of `code`'s seed holds, opened with the
 * new device's `secretKey`: each share, and the second number it came with (#398).
 */
export function releasedShares(
  fake: FakeRelay,
  seed: Uint8Array,
  secretKey: Uint8Array,
): Release[] {
  const { mailbox, key } = recoveryChannel(seed);
  return fake.blobs(mailbox).flatMap((blob) => {
    const box = xchachaSeal.open(mailbox, key, blob);
    const release = box === null ? null : openRelease(secretKey, mailbox, box);
    return release === null ? [] : [release];
  });
}

/** The 16-byte tag of `device`'s one hold in `groupId`. */
export async function holdTag(device: TestDevice, groupId: string): Promise<string> {
  const [hold] = (await groupOn(device, groupId)).recoveryHolds ?? [];
  if (hold === undefined) throw new Error('Expected a hold.');
  return hold.tag;
}

/** `text` as base64url-decoded bytes: a helper for tags and splits. */
export function bytesOf(text: string): Uint8Array {
  return fromBase64url(text);
}
