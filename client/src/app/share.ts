/**
 * Sharing out of the app (#77; docs/spec/phase-1-spec.md §9, "Shares carry no
 * content"): Tell your group's line, and the one way it leaves the device.
 *
 * What's shared goes into third-party chats, so it is fixed copy whose only
 * variable is a deadline, formatted on the device, and the app's address,
 * `location.origin + '/'`. It never carries a title, Document text, a group
 * name, a link fragment or a secret, and Web Share never gets a `title`,
 * because some apps use it as a subject line.
 */
import type { Proposal } from '../engine/fold';
import { formatDay } from './format';
import { messages } from './messages';

/** Which line Tell your group offers: after proposing, or after adding a version. */
export type TellKind = 'proposal' | 'version';

/** What a share carries: text and an address, and nothing else. */
export interface SharePayload {
  readonly text: string;
  readonly url: string;
}

/** How a share went: through Web Share, copied instead, or blocked both ways. */
export type ShareOutcome = 'shared' | 'copied' | 'blocked';

/** The Web Share API's `navigator.share`. */
export type WebShare = (data: ShareData) => Promise<void>;

/** Where a share can go: Web Share, where the browser has it, and the clipboard. */
export interface ShareTargets {
  /** `navigator.share`, or undefined where the browser has none. */
  readonly share: WebShare | undefined;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
}

/**
 * Tell your group's line: "I proposed a change in Reconcile. Voting ends Fri
 * 14 Nov.", or "I added a version…". `deadline` is a relay minute, dated in
 * the device's time zone unless a test names one.
 */
export function tellText(kind: TellKind, deadline: number, timeZone?: string): string {
  return messages.tell[kind](formatDay(deadline, timeZone));
}

/** What Tell your group shares: its line, and the app's address with nothing after the `/`. */
export function tellPayload(
  kind: TellKind,
  deadline: number,
  origin: string,
  timeZone?: string,
): SharePayload {
  return { text: tellText(kind, deadline, timeZone), url: `${origin}/` };
}

/**
 * The line Tell your group offers `me` on `proposal`: `proposal` when they
 * proposed it, `version` when they added a version to it, and null otherwise.
 */
export function tellKind(
  proposal: Pick<Proposal, 'author' | 'versions'>,
  me: string,
): TellKind | null {
  if (proposal.author === me) return 'proposal';
  return proposal.versions.some((version) => version.author === me) ? 'version' : null;
}

/**
 * Shares `text` and `url` through Web Share, with no `title`. Where the
 * browser has no Web Share, or the share is rejected (closing the sheet
 * rejects too), it copies the text and the address instead.
 */
export async function shareOrCopy(
  { text, url }: SharePayload,
  { share, copyText }: ShareTargets,
): Promise<ShareOutcome> {
  if (share !== undefined) {
    const shared = await share({ text, url }).then(
      () => true,
      () => false,
    );
    if (shared) return 'shared';
  }
  return copyText(`${text} ${url}`).then(
    () => 'copied' as const,
    () => 'blocked' as const,
  );
}

/** The browser's `navigator.share`, bound to `navigator`, or undefined where there is none. */
export function browserShare(): WebShare | undefined {
  const { share } = navigator as Partial<Navigator>;
  return typeof share === 'function' ? (data) => share.call(navigator, data) : undefined;
}
