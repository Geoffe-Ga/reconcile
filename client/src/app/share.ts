/**
 * Sharing out of the app (#77, #113; docs/spec/phase-1-spec.md §9, "Shares
 * carry no content"): Tell your group's message, and the one way it leaves
 * the device. Also saving the backup file (#78): through the share sheet
 * where it takes files, and as a download otherwise. The file goes only
 * where the person puts it; nothing is uploaded.
 *
 * What's shared goes into third-party chats, so it is one of the fixed
 * messages in ./chatMessages.ts, whose only variables are a deadline,
 * formatted on the device, and a title the person chose to include for that
 * one share, and the vote's link, `{origin}/#vote/{token}` (#472, ADR-0079).
 * The token is keyed by the group's secret, so the link names no group and
 * no Proposal, and to anyone outside the group it's 22 random characters;
 * before ADR-0079, a share carried the app's bare address. A share never
 * carries Document text, a group name, a member's name, a group or Proposal
 * id, any other link fragment or a secret, and Web Share never gets a
 * `title`, because some apps use it as a subject line.
 * The exceptions are Share link (#105, `personalSharing.ts`), whose whole
 * point is the link's fragment: it goes beside fixed words, never the
 * Document's title or text; and a recovering device's code (#118), whose
 * whole point is to reach the person's recovery contacts: it goes beside
 * fixed words and the app's address, and the six digits read out on a call
 * catch a code swapped on its way. A reconcile card's link and a follow link
 * (#424, {@link shareLink}) go alone, with no words at all: the link names no
 * group, and what it opens is the card or the coalition, for 2 days.
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

/**
 * What a Share button beside a link needs (#424): the browser's Web Share, or
 * undefined where it has none, when Share copies the link instead. A screen
 * that passes none shows Copy alone.
 */
export type SharePort = Pick<ShareTargets, 'share'>;

/** How sharing a link went: as {@link ShareOutcome}, or `cancelled` when the sheet was closed, which does nothing. */
export type LinkShareOutcome = ShareOutcome | 'cancelled';

/** How one Web Share went: shared, closed from the sheet, or refused, which a browser with none counts as. */
type Attempt = 'shared' | 'cancelled' | 'refused';

/** Whether `error` is the rejection Web Share gives when the person closes the sheet. */
function isCancel(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Hands `data` to Web Share, with no `title`, and says how it went. */
async function tryShare(share: WebShare | undefined, data: ShareData): Promise<Attempt> {
  if (share === undefined) return 'refused';
  return share(data).then(
    () => 'shared' as const,
    (error: unknown) => (isCancel(error) ? 'cancelled' : 'refused'),
  );
}

/** Copies `text`: `copied`, or `blocked` when the browser blocks it. */
function copyOut(copyText: ShareTargets['copyText'], text: string): Promise<'copied' | 'blocked'> {
  return copyText(text).then(
    () => 'copied' as const,
    () => 'blocked' as const,
  );
}

/** What Tell your group shares at `moment`: its message, and `link`, the vote's link (#472). */
export function chatPayload(
  moment: ChatMoment,
  details: ChatDetails,
  link: string,
  timeZone?: string,
): SharePayload {
  return { text: chatMessage(moment, details, timeZone), url: link };
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
  const attempt = await tryShare(share, { text, url });
  return attempt === 'shared' ? 'shared' : copyOut(copyText, `${text} ${url}`);
}

/**
 * Shares a reconcile card's link or a follow link (#424; ADR-0077 §6): the
 * link alone, with no `title` and no `text`, so nothing beside it names a
 * group. Where the browser has no Web Share, or refuses (as it does without a
 * tap to answer), it copies the link instead, as {@link shareOrCopy} does.
 * Closing the sheet shares and copies nothing, as it saves nothing in
 * {@link saveFile}, so the clipboard keeps what the person had there.
 */
export async function shareLink(
  link: string,
  { share, copyText }: ShareTargets,
): Promise<LinkShareOutcome> {
  const attempt = await tryShare(share, { url: link });
  return attempt === 'refused' ? copyOut(copyText, link) : attempt;
}

/** The browser's `navigator.share`, bound to `navigator`, or undefined where there is none. */
export function browserShare(): WebShare | undefined {
  const { share } = navigator as Partial<Navigator>;
  return typeof share === 'function' ? (data) => share.call(navigator, data) : undefined;
}

/** How saving a file went: through the share sheet, as a download, or not at all. */
export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled';

/** Where a file can go: the share sheet, where it takes files, or a download. */
export interface FileTargets {
  /** `navigator.canShare`, or undefined where the browser has none. */
  readonly canShare: ((data: ShareData) => boolean) | undefined;
  /** `navigator.share`, or undefined where the browser has none. */
  readonly share: WebShare | undefined;
  /** Downloads the file ({@link downloadFile} in the app). */
  readonly download: (file: File) => void;
}

/** How long a download's blob URL lives after its click, so a slow browser still reads it. */
const REVOKE_AFTER_MS = 40_000;

/**
 * Saves `file`: hands it, alone, to the share sheet when `canShare` says it
 * takes files (the reliable path in an installed iPhone app), and downloads
 * it otherwise (Android Chrome won't share this file type) or when sharing
 * fails. Closing the sheet saves nothing.
 */
export async function saveFile(file: File, targets: FileTargets): Promise<SaveOutcome> {
  const { canShare, share, download } = targets;
  if (share !== undefined && canShare?.({ files: [file] }) === true) {
    const outcome = await share({ files: [file] }).then(
      () => 'shared' as const,
      (error: unknown) => (isCancel(error) ? 'cancelled' : null),
    );
    if (outcome !== null) return outcome;
  }
  download(file);
  return 'downloaded';
}

/** Downloads `file` under its own name, through an `<a download>` on a blob URL. */
export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_AFTER_MS);
}

/** The browser's `canShare` and `share`, bound to `navigator`, and {@link downloadFile}. */
export function browserFileTargets(): FileTargets {
  const { canShare } = navigator as Partial<Navigator>;
  return {
    canShare: typeof canShare === 'function' ? (data) => canShare.call(navigator, data) : undefined,
    share: browserShare(),
    download: downloadFile,
  };
}

/** Two digits, as a date writes a month or day. */
const twoDigits = (n: number): string => String(n).padStart(2, '0');

/** The backup file's generic name, with the day it was made on the device: reconcile-backup-2026-11-08.bin. */
export function backupFileName(day: Date): string {
  const date = `${String(day.getFullYear())}-${twoDigits(day.getMonth() + 1)}-${twoDigits(day.getDate())}`;
  return `reconcile-backup-${date}.bin`;
}

/** A backup's sealed bytes as a file of plain bytes, named for `day`. */
export function backupFile(bytes: Uint8Array<ArrayBuffer>, day: Date): File {
  return new File([bytes], backupFileName(day), { type: 'application/octet-stream' });
}
