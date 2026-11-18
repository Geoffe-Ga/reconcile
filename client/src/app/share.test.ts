import { describe, expect, it, vi } from 'vitest';

import { voteToken } from '../crypto/voteLink';
import { testGroup } from '../test/groups';
import { type ChatMoment, chatDetails, chatMessage } from './chatMessages';
import {
  backupFile,
  backupFileName,
  browserFileTargets,
  browserShare,
  chatPayload,
  downloadFile,
  type FileTargets,
  saveFile,
  shareLink,
  shareOrCopy,
  type WebShare,
} from './share';
import { MINUTE_MS } from './time';
import { voteLinkOf } from './voteLink';

/** A relay minute on Friday 14 November 2025 at 12:00 UTC. */
const FRIDAY_NOON = Date.UTC(2025, 10, 14, 12) / MINUTE_MS;
const URL_ = 'https://reconcile.test/';

describe('chatPayload', () => {
  it('is the moment’s message and the vote’s link (#472)', () => {
    const link = `https://reconcile.test/#vote/${'k9V2'.repeat(5)}xY`;
    expect(chatPayload('open', { deadline: FRIDAY_NOON }, link, 'UTC')).toEqual({
      text: 'A new Proposal is open in Reconcile. Voting ends Fri 14 Nov.',
      url: link,
    });
  });
});

describe('what Tell your group shares, at every moment', () => {
  const CANARY_GROUP = 'Canary Street Commons';
  const CANARY_TITLE = 'Canary title: open the garden';
  const CANARY_ATOM = 'Canary atom: the garden opens at dawn.';
  const CANARY_FOUNDER = 'Canarina Founder';
  const CANARY_JOINER = 'Canaryo Joiner';
  /** What an invite link carries after its `#`, which no share may hold. */
  const CANARY_FRAGMENT = '#/join/';
  const ORIGIN = 'https://reconcile.test';
  /** The group's secret, which keys the vote link's token (#472). */
  const SECRET = new Uint8Array(32).fill(5);
  const MOMENTS: readonly ChatMoment[] = ['open', 'version', 'closing', 'result'];

  /** Shares `moment`'s payload through Web Share, then copies it where there is none. */
  async function shareBothWays(moment: ChatMoment, includeTitle: boolean) {
    const { state } = testGroup({
      name: CANARY_GROUP,
      founder: CANARY_FOUNDER,
      joiners: [CANARY_JOINER],
      atoms: [CANARY_ATOM],
      proposals: [CANARY_TITLE],
    });
    const [proposal] = state.proposals;
    if (proposal === undefined || state.group === null) throw new Error('Expected the Proposal.');
    const details = chatDetails(proposal, includeTitle);
    const link = voteLinkOf(ORIGIN, voteToken(SECRET, proposal.id));
    const share = vi.fn<WebShare>(() => Promise.resolve());
    const copied: string[] = [];
    const copyText = vi.fn((text: string) => {
      copied.push(text);
      return Promise.resolve();
    });

    await shareOrCopy(chatPayload(moment, details, link, 'UTC'), { share, copyText });
    await shareOrCopy(chatPayload(moment, details, link, 'UTC'), { share: undefined, copyText });

    const [shared] = share.mock.calls[0] ?? [];
    expect(shared).toEqual({ text: chatMessage(moment, details, 'UTC'), url: link });
    // Some apps use Web Share's title as a subject line: it never gets one.
    expect(Object.keys(shared ?? {})).toEqual(['text', 'url']);
    // Where there's no share sheet, the copy ends with the vote's link.
    expect(copied).toEqual([`${chatMessage(moment, details, 'UTC')} ${link}`]);
    const sent = [JSON.stringify(shared), ...copied];
    for (const text of sent) {
      // The link names no group and no Proposal: neither id is in any share (#472).
      expect(text).not.toContain(state.group);
      expect(text).not.toContain(proposal.id);
      // Its one fragment is the vote link's.
      expect(text.split('#')).toHaveLength(2);
      expect(text).toContain('#vote/');
    }
    return sent.map((text) => text.replace(link, ''));
  }

  it.each(MOMENTS)(
    'carries no title, group name, Document text, member name or other fragment unticked (%s)',
    async (moment) => {
      for (const sent of await shareBothWays(moment, false)) {
        for (const canary of [
          CANARY_GROUP,
          CANARY_TITLE,
          CANARY_ATOM,
          CANARY_FOUNDER,
          CANARY_JOINER,
          CANARY_FRAGMENT,
          'Canar',
          '#',
        ]) {
          expect(sent).not.toContain(canary);
        }
      }
    },
  );

  it.each(MOMENTS)(
    'carries the title once ticked, and still no group name, text, names or other fragment (%s)',
    async (moment) => {
      for (const sent of await shareBothWays(moment, true)) {
        expect(sent).toContain(CANARY_TITLE);
        for (const canary of [
          CANARY_GROUP,
          CANARY_ATOM,
          CANARY_FOUNDER,
          CANARY_JOINER,
          CANARY_FRAGMENT,
          '#',
        ]) {
          expect(sent).not.toContain(canary);
        }
      }
    },
  );
});

describe('shareOrCopy', () => {
  it('hands Web Share the text and the address, and no title', async () => {
    const share = vi.fn<WebShare>(() => Promise.resolve());
    const copyText = vi.fn(() => Promise.resolve());

    const result = await shareOrCopy({ text: 'A vote is open.', url: URL_ }, { share, copyText });

    expect(result).toBe('shared');
    expect(share).toHaveBeenCalledTimes(1);
    const [data] = share.mock.calls[0] ?? [];
    expect(data).toEqual({ text: 'A vote is open.', url: URL_ });
    expect(data !== undefined && 'title' in data).toBe(false);
    expect(copyText).not.toHaveBeenCalled();
  });

  it('copies the text and the address when the browser has no Web Share', async () => {
    const copyText = vi.fn(() => Promise.resolve());
    const result = await shareOrCopy(
      { text: 'A vote is open.', url: URL_ },
      { share: undefined, copyText },
    );
    expect(result).toBe('copied');
    expect(copyText).toHaveBeenCalledWith(`A vote is open. ${URL_}`);
  });

  it('copies them when Web Share is rejected, as when someone closes the sheet', async () => {
    const share = vi.fn(() => Promise.reject(new DOMException('Cancelled', 'AbortError')));
    const copyText = vi.fn(() => Promise.resolve());
    expect(await shareOrCopy({ text: 'A vote is open.', url: URL_ }, { share, copyText })).toBe(
      'copied',
    );
    expect(copyText).toHaveBeenCalledWith(`A vote is open. ${URL_}`);
  });

  it('says so when copying is blocked too', async () => {
    const copyText = vi.fn(() => Promise.reject(new Error('blocked')));
    expect(
      await shareOrCopy({ text: 'A vote is open.', url: URL_ }, { share: undefined, copyText }),
    ).toBe('blocked');
  });
});

describe('shareLink (#424)', () => {
  const CARD = 'https://reconcile.test/#reconcile/abc';

  it('hands Web Share the link alone: no title and no text, so nothing names a group', async () => {
    const share = vi.fn<WebShare>(() => Promise.resolve());
    const copyText = vi.fn(() => Promise.resolve());

    expect(await shareLink(CARD, { share, copyText })).toBe('shared');

    expect(share.mock.calls).toEqual([[{ url: CARD }]]);
    expect(copyText).not.toHaveBeenCalled();
  });

  it('copies the link alone when the browser has no Web Share', async () => {
    const copyText = vi.fn(() => Promise.resolve());
    expect(await shareLink(CARD, { share: undefined, copyText })).toBe('copied');
    expect(copyText.mock.calls).toEqual([[CARD]]);
  });

  it('copies the link when Web Share refuses it, as without a user’s tap', async () => {
    const share = vi.fn(() => Promise.reject(new DOMException('No tap', 'NotAllowedError')));
    const copyText = vi.fn(() => Promise.resolve());
    expect(await shareLink(CARD, { share, copyText })).toBe('copied');
    expect(copyText.mock.calls).toEqual([[CARD]]);
  });

  it('does nothing when someone closes the sheet: no copy, and cancelled', async () => {
    const share = vi.fn(() => Promise.reject(new DOMException('Share canceled', 'AbortError')));
    const copyText = vi.fn(() => Promise.resolve());
    expect(await shareLink(CARD, { share, copyText })).toBe('cancelled');
    expect(copyText).not.toHaveBeenCalled();
  });

  it('says so when Web Share refuses and copying is blocked too', async () => {
    const share = vi.fn(() => Promise.reject(new TypeError('Not shareable')));
    const copyText = vi.fn(() => Promise.reject(new Error('blocked')));
    expect(await shareLink(CARD, { share, copyText })).toBe('blocked');
  });
});

describe('browserShare', () => {
  it('is the browser’s own Web Share, called on navigator', async () => {
    const calls: unknown[] = [];
    const share = vi.fn(function (this: unknown) {
      calls.push(this);
      return Promise.resolve();
    });
    vi.stubGlobal('navigator', { share });
    const found = browserShare();
    await found?.({ text: 'x' });
    expect(calls).toEqual([navigator]);
    vi.unstubAllGlobals();
  });

  it('is undefined where the browser has none, so the app copies instead', () => {
    vi.stubGlobal('navigator', {});
    expect(browserShare()).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('saveFile', () => {
  const file = new File([Uint8Array.of(1, 2, 3)], 'reconcile-backup-2026-11-08.bin');

  /** Targets whose share sheet takes files when `takesFiles`, recording every call. */
  function fileTargets(takesFiles: boolean, share?: WebShare) {
    const shared = vi.fn<WebShare>(share ?? (() => Promise.resolve()));
    const download = vi.fn<(file: File) => void>();
    const canShare = vi.fn((data: ShareData) => takesFiles && data.files?.length === 1);
    const targets: FileTargets = { canShare, share: shared, download };
    return { targets, shared, download, canShare };
  }

  it('hands the file alone to the share sheet when it takes files, as an installed iPhone app’s does', async () => {
    const { targets, shared, download, canShare } = fileTargets(true);

    expect(await saveFile(file, targets)).toBe('shared');

    expect(canShare).toHaveBeenCalledWith({ files: [file] });
    expect(shared).toHaveBeenCalledWith({ files: [file] });
    expect(Object.keys(shared.mock.calls[0]?.[0] ?? {})).toEqual(['files']);
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads the file when the share sheet won’t take it, as Android Chrome’s won’t', async () => {
    const { targets, shared, download } = fileTargets(false);

    expect(await saveFile(file, targets)).toBe('downloaded');

    expect(shared).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledWith(file);
  });

  it('downloads it where the browser has no Web Share at all', async () => {
    const download = vi.fn<(file: File) => void>();

    expect(await saveFile(file, { canShare: undefined, share: undefined, download })).toBe(
      'downloaded',
    );
    expect(download).toHaveBeenCalledWith(file);
  });

  it('saves nothing when the person closes the share sheet', async () => {
    const abort = () => Promise.reject(new DOMException('Share canceled', 'AbortError'));
    const { targets, download } = fileTargets(true, abort);

    expect(await saveFile(file, targets)).toBe('cancelled');
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads it when sharing fails any other way', async () => {
    const refuse = () => Promise.reject(new DOMException('No activation', 'NotAllowedError'));
    const { targets, download } = fileTargets(true, refuse);

    expect(await saveFile(file, targets)).toBe('downloaded');
    expect(download).toHaveBeenCalledWith(file);
  });
});

describe('downloadFile', () => {
  it('clicks an <a download> on a blob URL with the file’s name, then removes it and frees the URL', () => {
    vi.useFakeTimers();
    const file = new File([Uint8Array.of(1)], 'reconcile-backup-2026-11-08.bin');
    const created = vi.fn(() => 'blob:https://reconcile.test/1');
    const revoked = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: created, revokeObjectURL: revoked });
    const clicked: { href: string; download: string; inPage: boolean }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download, inPage: this.isConnected });
    });

    downloadFile(file);

    expect(created).toHaveBeenCalledWith(file);
    expect(clicked).toEqual([
      {
        href: 'blob:https://reconcile.test/1',
        download: 'reconcile-backup-2026-11-08.bin',
        inPage: true,
      },
    ]);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoked).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoked).toHaveBeenCalledWith('blob:https://reconcile.test/1');
    click.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

describe('browserFileTargets', () => {
  it('are the browser’s own canShare and share, called on navigator, and the download', async () => {
    const calls: unknown[] = [];
    const share = vi.fn(function (this: unknown) {
      calls.push(this);
      return Promise.resolve();
    });
    const canShare = vi.fn(function (this: unknown) {
      calls.push(this);
      return true;
    });
    vi.stubGlobal('navigator', { share, canShare });

    const found = browserFileTargets();
    expect(found.canShare?.({})).toBe(true);
    await found.share?.({});

    expect(calls).toEqual([navigator, navigator]);
    expect(found.download).toBe(downloadFile);
    vi.unstubAllGlobals();
  });

  it('leave out canShare where the browser has none', () => {
    vi.stubGlobal('navigator', {});
    expect(browserFileTargets().canShare).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('the backup file', () => {
  it('has a generic name with the day it was saved, in the device’s time zone', () => {
    expect(backupFileName(new Date(2026, 10, 8, 23, 59))).toBe('reconcile-backup-2026-11-08.bin');
    expect(backupFileName(new Date(2027, 0, 3, 0, 1))).toBe('reconcile-backup-2027-01-03.bin');
  });

  it('is plain bytes, under that name', async () => {
    const file = backupFile(Uint8Array.of(82, 67, 66, 49), new Date(2026, 10, 8));

    expect(file.name).toBe('reconcile-backup-2026-11-08.bin');
    expect(file.type).toBe('application/octet-stream');
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([82, 67, 66, 49]);
  });
});
