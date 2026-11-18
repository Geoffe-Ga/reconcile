/**
 * Reports and appeals on the app's services (#490; listed-doors.md §6.3):
 * Report this entry from a shelf entry's page, and Ask the steward to look
 * again from Group home. Both go only where the app pins a steward
 * ({@link stewardPinned}): with none, neither shows, and nothing a person
 * sees changes.
 *
 * An appeal is the group's, so it is signed with its listed door's key, and
 * only a member who may propose sends one: {@link appealFrom} asks the
 * group's own log again, whatever the screen showed.
 */
import { can } from '../engine/capabilities';
import { listedUnder } from '../engine/optIns';
import { openDoor } from '../door/keeper';
import type { Relay } from '../net/relay';
import type { Clause } from '../shelf/record';
import { sendAppeal, sendReport } from '../shelf/report';
import { STEWARD_PINS, type StewardPins } from '../shelf/steward';
import type { Group, Me } from '../store/db';
import { foldGroup } from '../store/expiry';
import type { SendOutcome } from './StewardDialogs';

/** What an appeal reads of its group: its log, and this device's member in it. */
export type AppealGroup = Pick<Group, 'log' | 'relayNow' | 'cleared'> & {
  readonly me: Pick<Me, 'author'>;
};

/** What sending reaches: the relay, and the store for an appeal's group. */
export interface ReportServices {
  readonly relay: Pick<Relay, 'putBlob'>;
  readonly store: { getGroup(groupId: string): Promise<AppealGroup | undefined> };
}

/** Whether the app pins a steward to send reports and appeals to (`pins`, the app's unless a test says). */
export function stewardPinned(pins: StewardPins | null = STEWARD_PINS): boolean {
  return pins !== null;
}

/** Report this entry: entry `id` under the listing at `address`, under `clause`, with `note`. */
export function reportEntry(
  services: Pick<ReportServices, 'relay'>,
  report: { readonly address: string; readonly id: string; readonly clause: Clause },
  note: string,
): Promise<SendOutcome> {
  return sendReport({ relay: services.relay }, { ...report, note });
}

/**
 * Ask the steward to look again, for group `groupId`: about its entry `id`,
 * or its whole listing for null, signed with its listed door's key.
 * `failed`, with nothing sent, unless this device's member may propose and
 * the group lists its open door.
 */
export async function appealFrom(
  services: ReportServices,
  groupId: string,
  id: string | null,
  note: string,
): Promise<SendOutcome> {
  const group = await services.store.getGroup(groupId);
  if (group === undefined) return 'failed';
  const state = foldGroup(group);
  const door = openDoor(state);
  if (door === null || listedUnder(door) === null) return 'failed';
  if (!can(state, group.me.author, 'propose')) return 'failed';
  return sendAppeal({ relay: services.relay }, door, { ...(id === null ? {} : { id }), note });
}
