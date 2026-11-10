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
      (error: unknown) =>
        error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : null,
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
