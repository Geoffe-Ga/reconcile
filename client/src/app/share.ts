/**
 * Sharing out of the app (#77, #113; docs/spec/phase-1-spec.md §9, "Shares
 * carry no content"): Tell your group's message, and the one way it leaves
 * the device.
 *
 * What's shared goes into third-party chats, so it is one of the fixed
 * messages in ./chatMessages.ts, whose only variables are a deadline,
 * formatted on the device, and a title the person chose to include for that
 * one share, and the app's address, `location.origin + '/'`. It never carries
 * Document text, a group name, a member's name, a link fragment or a secret,
 * and Web Share never gets a `title`, because some apps use it as a subject line.
 */
import { type ChatDetails, type ChatMoment, chatMessage } from './chatMessages';

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

/** What Tell your group shares at `moment`: its message, and the app's address with nothing after the `/`. */
export function chatPayload(
  moment: ChatMoment,
  details: ChatDetails,
  origin: string,
  timeZone?: string,
): SharePayload {
  return { text: chatMessage(moment, details, timeZone), url: `${origin}/` };
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
