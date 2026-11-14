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
 *   On a device whose keys are locked with a passkey, those three live in
 *   the vault ({@link replySealing}, #265), so a reply opens only once it's
 *   unlocked.
 * - **A member's device** keeps the applications it read from its group's
 *   inbox ({@link DoorInbox}) on the group's own record, so Leave deletes them
 *   with the group and an archive drops them (#77, #108). Dismiss hides one
 *   on this device only.
 *
 * An application may carry a copy of personal Documents the applicant chose
 * (#425; ADR-0077 §3): only their titles and text. It sits on the member's
 * device beside the name and message, so a passkey-locked device keeps it
 * as the rest of the application, on the group's record, which a locked
 * store hands back only once unlocked, and the vault keeps keys alone. Each
 * device deletes the copy once the application is dismissed there
 * ({@link dismissed}) or answered ({@link withoutCopies}): the name and
 * message stay, so the same application is never read in again.
 */

import type { Sealing } from './sealing';
import type { Secrets } from './vault';

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

/**
 * An application's secrets (#265): the reply seed and key, and the invite's
 * seed once a reply opened, which together open the reply and join the group.
 */
export type ReplyKeys = Pick<SentApplication, 'seed' | 'replyKey' | 'invite'>;

/**
 * A sent application as IndexedDB keeps it: whole on a device with no vault,
 * and without its reply keys under one, which holds them (#265). One kept
 * before #265 holds them until the device seals or unlocks.
 */
export type StoredSent = Omit<SentApplication, keyof ReplyKeys> & Partial<ReplyKeys>;

/**
 * A sent application's sealing (#265): its reply seed, reply key and any
 * invite's seed go into the vault, and its record keeps the door, the
 * group's name and when it was sent.
 */
export const replySealing: Sealing<SentApplication, StoredSent> = {
  hasSecrets: () => true,
  split(sent) {
    const { seed, replyKey, invite, ...kept } = sent;
    if (!seed || !replyKey) return { kept: sent, secrets: null };
    return { kept, secrets: { seed, replyKey, ...(invite ? { invite } : {}) } };
  },
  join(kept, secrets) {
    const held: Secrets = secrets ?? {};
    const { seed, replyKey, invite } = held;
    if (!seed || !replyKey) return null;
    return { ...kept, seed, replyKey, ...(invite ? { invite } : {}) };
  },
};

/** One personal Document as an application carries a copy of it (#425): its title and text, nothing else. */
export interface ApplicationDocument {
  /** 1 to 120 code points, not blank. */
  readonly title: string;
  /** The text as the applicant wrote it, Markdown and all: every screen shows it as plain text. */
  readonly text: string;
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
  /** The copy of personal Documents it carried (#425), until it's dismissed or answered. */
  readonly documents?: readonly ApplicationDocument[];
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

/** `application` without the copy of Documents it carried (#425). */
function withoutCopy(application: ReceivedApplication): ReceivedApplication {
  const { documents, ...kept } = application;
  return documents === undefined ? application : kept;
}

/**
 * `inbox` with the application `id` dismissed on this device, and the copy
 * of Documents it carried deleted (#425).
 */
export function dismissed(inbox: DoorInbox, id: string): DoorInbox {
  return {
    ...inbox,
    applications: inbox.applications.map((application) =>
      application.id === id ? { ...withoutCopy(application), dismissed: true } : application,
    ),
  };
}

/**
 * `inbox` with the copy of Documents deleted from each application
 * `answered` names (#425): an invite folded for it. The applications stay.
 */
export function withoutCopies(inbox: DoorInbox, answered: (id: string) => boolean): DoorInbox {
  return {
    ...inbox,
    applications: inbox.applications.map((application) =>
      answered(application.id) ? withoutCopy(application) : application,
    ),
  };
}

/** Whether `inbox` still holds a copy of Documents for any application `answered` names. */
export function holdsCopies(
  inbox: DoorInbox | undefined,
  answered: (id: string) => boolean,
): boolean {
  return (inbox?.applications ?? []).some(
    (application) => application.documents !== undefined && answered(application.id),
  );
}
