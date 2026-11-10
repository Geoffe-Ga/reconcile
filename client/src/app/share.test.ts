import { describe, expect, it, vi } from 'vitest';

import { testGroup } from '../test/groups';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { browserShare, shareOrCopy, tellKind, tellPayload, tellText, type WebShare } from './share';
import { MINUTE_MS } from './time';

/** A relay minute on Friday 14 November 2025 at 12:00 UTC. */
const FRIDAY_NOON = Date.UTC(2025, 10, 14, 12) / MINUTE_MS;
const URL_ = 'https://reconcile.test/';

describe('tellText', () => {
  it('is fixed copy whose only variable is the deadline, formatted on the device', () => {
    expect(tellText('proposal', FRIDAY_NOON, 'UTC')).toBe(
      'I proposed a change in Reconcile. Voting ends Fri 14 Nov.',
    );
    expect(tellText('version', FRIDAY_NOON, 'UTC')).toBe(
      'I added a version in Reconcile. Voting ends Fri 14 Nov.',
    );
  });

  it('dates the deadline in the device’s own time zone', () => {
    expect(tellText('proposal', FRIDAY_NOON, 'Pacific/Kiritimati')).toBe(
      'I proposed a change in Reconcile. Voting ends Sat 15 Nov.',
    );
  });
});

describe('tellKind', () => {
  it('offers the Proposal’s wording to its proposer, and the version’s to whoever added one', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const p = log.propose('ana');
    log.version('ben', p, 'Quiet after midnight.');
    const [proposal] = log.state().proposals;
    if (proposal === undefined) throw new Error('Expected the Proposal.');
    expect(tellKind(proposal, authorOf('ana'))).toBe('proposal');
    expect(tellKind(proposal, authorOf('ben'))).toBe('version');
    expect(tellKind(proposal, authorOf('cal'))).toBeNull();
  });
});

describe('what Tell your group shares', () => {
  const CANARY_GROUP = 'Canary Street Commons';
  const CANARY_TITLE = 'Canary title: open the garden';
  const CANARY_ATOM = 'Canary atom: the garden opens at dawn.';
  const ORIGIN = 'https://reconcile.test';

  it.each(['proposal', 'version'] as const)(
    'carries no group name, title, Document text, fragment or title field (%s)',
    async (kind) => {
      const { state, founder } = testGroup({
        name: CANARY_GROUP,
        atoms: [CANARY_ATOM],
        proposals: [CANARY_TITLE],
      });
      const [proposal] = state.proposals;
      if (proposal === undefined) throw new Error('Expected the Proposal.');
      expect(tellKind(proposal, founder)).toBe('proposal');
      const payload = tellPayload(kind, proposal.deadline, ORIGIN, 'UTC');
      const share = vi.fn<WebShare>(() => Promise.resolve());
      const copied: string[] = [];
      const copyText = vi.fn((text: string) => {
        copied.push(text);
        return Promise.resolve();
      });

      await shareOrCopy(payload, { share, copyText });
      await shareOrCopy(payload, { share: undefined, copyText });

      const [shared] = share.mock.calls[0] ?? [];
      expect(shared).toEqual({ text: tellText(kind, proposal.deadline, 'UTC'), url: `${ORIGIN}/` });
      expect(Object.keys(shared ?? {})).toEqual(['text', 'url']);
      for (const sent of [JSON.stringify(shared), ...copied]) {
        for (const canary of [CANARY_GROUP, CANARY_TITLE, CANARY_ATOM, 'Canary', '#']) {
          expect(sent).not.toContain(canary);
        }
      }
      expect(copied).toEqual([`${tellText(kind, proposal.deadline, 'UTC')} ${ORIGIN}/`]);
    },
  );

  it('is the app’s origin and a slash, with no path or fragment', () => {
    expect(tellPayload('proposal', 0, 'https://reconcile.test', 'UTC').url).toBe(
      'https://reconcile.test/',
    );
  });
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
