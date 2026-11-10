import { describe, expect, it, vi } from 'vitest';

import { testGroup } from '../test/groups';
import { type ChatMoment, chatDetails, chatMessage } from './chatMessages';
import { browserShare, chatPayload, shareOrCopy, type WebShare } from './share';
import { MINUTE_MS } from './time';

/** A relay minute on Friday 14 November 2025 at 12:00 UTC. */
const FRIDAY_NOON = Date.UTC(2025, 10, 14, 12) / MINUTE_MS;
const URL_ = 'https://reconcile.test/';

describe('chatPayload', () => {
  it('is the moment’s message and the app’s origin and a slash, with no path or fragment', () => {
    expect(chatPayload('open', { deadline: FRIDAY_NOON }, 'https://reconcile.test', 'UTC')).toEqual(
      {
        text: 'A new Proposal is open in Reconcile. Voting ends Fri 14 Nov.',
        url: 'https://reconcile.test/',
      },
    );
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
    if (proposal === undefined) throw new Error('Expected the Proposal.');
    const details = chatDetails(proposal, includeTitle);
    const share = vi.fn<WebShare>(() => Promise.resolve());
    const copied: string[] = [];
    const copyText = vi.fn((text: string) => {
      copied.push(text);
      return Promise.resolve();
    });

    await shareOrCopy(chatPayload(moment, details, ORIGIN, 'UTC'), { share, copyText });
    await shareOrCopy(chatPayload(moment, details, ORIGIN, 'UTC'), { share: undefined, copyText });

    const [shared] = share.mock.calls[0] ?? [];
    expect(shared).toEqual({ text: chatMessage(moment, details, 'UTC'), url: `${ORIGIN}/` });
    // Some apps use Web Share's title as a subject line: it never gets one.
    expect(Object.keys(shared ?? {})).toEqual(['text', 'url']);
    expect(copied).toEqual([`${chatMessage(moment, details, 'UTC')} ${ORIGIN}/`]);
    return [JSON.stringify(shared), ...copied];
  }

  it.each(MOMENTS)(
    'carries no title, group name, Document text, member name or fragment unticked (%s)',
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
    'carries the title once ticked, and still no group name, text, names or fragment (%s)',
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
