/**
 * What a device keeps about front-door applications (#121; ADR-0038).
 *
 * Two sides, each on the device alone, never in the group's log or a backup
 * file:
 *
 * - **An applicant's device** keeps each application it sent
 *   ({@link SentApplication}) in a store of its own, in no group: the reply
 *   key and seed only it holds, so it can find and open a reply, for
 *   {@link SENT_DAYS} days. A reply's invite seed joins it once one opens.
 * - **A member's device** keeps the applications it read from its group's
 *   inbox ({@link DoorInbox}) on the group's own record, so Leave deletes them
 *   with the group and an archive drops them (#77, #108). Dismiss hides one
 *   on this device only.
 */

/** How long an applicant's device looks for a reply: the relay keeps the application this long. */
export const SENT_DAYS = 30;

/** What {@link Store.subscribe}'s listeners hear when sent applications change: never a group id. */
export const SENT_CHANGED = 'applications';

/** An application this device sent at a front door. */
export interface SentApplication {
  /** The application's id: the SHA-256 of its sealed blob, as the group's members name it. */
  readonly id: string;
  /** The door's address, in unpadded base64url. */
  readonly door: string;
  /** The group's name as the page showed it, for Your groups. */
  readonly groupName: string;
  /** The 32-byte reply seed, whose reply mailbox the device reads. */
  readonly seed: Uint8Array;
  /** The X25519 secret key a reply is sealed to. It never leaves the device. */
  readonly replyKey: Uint8Array;
  /** When it was sent, in device milliseconds. */
  readonly sentAt: number;
  /** The invite's 32-byte seed, once a reply with one opened. */
  readonly invite?: Uint8Array;
}

/** An application a member's device read from its group's inbox. */
export interface ReceivedApplication {
  /** The SHA-256 of its sealed blob, in unpadded base64url: what a `door-invited` names. */
  readonly id: string;
  /** Its place in the relay's order. */
  readonly seq: number;
  /** The relay minute it arrived. */
  readonly received: number;
  /** The name the applicant would like to use. */
  readonly name: string;
  /** Why they'd like to join. */
  readonly message: string;
  /** Where an invite goes: the applicant's reply seed and key, each in unpadded base64url. */
  readonly reply: { readonly seed: string; readonly key: string };
  /** Set once someone dismissed it on this device. */
  readonly dismissed?: true;
}

/** A group's front-door inbox as this device last read it. */
export interface DoorInbox {
  /** The inbox mailbox id it was read from: a new door's inbox starts afresh. */
  readonly inbox: string;
  /** The highest seq read so far. */
  readonly cursor: number;
  /** The relay instance the cursor belongs to, or null before the first read. */
  readonly instance: string | null;
  /** Every application read, oldest first, by id. */
  readonly applications: readonly ReceivedApplication[];
}

/** The applications sent store's side of the device's store. */
export interface SentStore {
  /** Every application this device sent and still keeps, oldest first. */
  listSent(): Promise<SentApplication[]>;
  /** Keep a sent application, in place of any of the same id. */
  addSent(application: SentApplication): Promise<void>;
  /** Replace the sent application `id` with `edit` of it, in one change; nothing when it's gone. */
  updateSent(id: string, edit: (held: SentApplication) => SentApplication): Promise<void>;
  /** Forget the sent application `id`. */
  dropSent(id: string): Promise<void>;
}

/** `inbox` with `applications` added, each once by id, in the order read. */
export function withApplications(
  inbox: DoorInbox,
  applications: readonly ReceivedApplication[],
): DoorInbox {
  const known = new Set(inbox.applications.map((application) => application.id));
  const fresh = applications.filter((application) => {
    if (known.has(application.id)) return false;
    known.add(application.id);
    return true;
  });
  return { ...inbox, applications: [...inbox.applications, ...fresh] };
}

/** `inbox` with the application `id` dismissed on this device. */
export function dismissed(inbox: DoorInbox, id: string): DoorInbox {
  return {
    ...inbox,
    applications: inbox.applications.map((application) =>
      application.id === id ? { ...application, dismissed: true } : application,
    ),
  };
}
