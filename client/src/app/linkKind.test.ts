/**
 * What a pasted link is and how a screen opens it (#423; ADR-0077 §6): link
 * in, route out, with no field around it, so Start's field, Discover's and
 * the floating link bar to come (#444) all read a link the same way.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { cardLink } from '../coalition/card';
import { followLink } from '../coalition/follow';
import { newCardSeed } from '../crypto/card';
import { newInviteSeed } from '../crypto/invite';
import { inviteLink } from './invite';
import { readLink } from './linkKind';

const ORIGIN = 'https://reconcile.example';
const ADDRESS = `${'A'.repeat(42)}E`;

/** A spy for every kind of link. */
function openers() {
  return {
    onOpenInvite: vi.fn(),
    onOpenCard: vi.fn(),
    onOpenFollow: vi.fn(),
    onOpenDoor: vi.fn(),
  };
}

/** The handlers `open` was called through, by name. */
function called(open: ReturnType<typeof openers>): string[] {
  return Object.entries(open)
    .filter(([, handler]) => handler.mock.calls.length > 0)
    .map(([name]) => name);
}

describe('readLink', () => {
  it.each([
    ['an invite', 'invite', 'onOpenInvite', (seed: Uint8Array) => inviteLink(ORIGIN, seed)],
    ['a reconcile card', 'card', 'onOpenCard', (seed: Uint8Array) => cardLink(ORIGIN, seed)],
    ['a follow link', 'follow', 'onOpenFollow', (seed: Uint8Array) => followLink(ORIGIN, seed)],
  ] as const)(
    'reads %s, and opening it hands its seed to that handler alone',
    (_name, kind, handler, link) => {
      const open = openers();
      const seed = kind === 'card' ? newCardSeed() : newInviteSeed();

      const read = readLink(` ${link(seed)}\n`, open);

      expect(read?.kind).toBe(kind);
      expect(called(open)).toEqual([]);
      read?.open();
      expect(called(open)).toEqual([handler]);
      expect(Array.from(open[handler].mock.calls[0]?.[0] as Uint8Array)).toEqual(Array.from(seed));
    },
  );

  it('reads a front door link from any origin, and opens it by its address', () => {
    const open = openers();

    const read = readLink(`https://elsewhere.example/#door/${ADDRESS}`, open);

    expect(read?.kind).toBe('door');
    read?.open();
    expect(called(open)).toEqual(['onOpenDoor']);
    expect(open.onOpenDoor).toHaveBeenCalledWith(ADDRESS);
  });

  it('leaves a front door link unread where the screen opens none (Start has its own field)', () => {
    const onOpenInvite = vi.fn();

    expect(readLink(`${ORIGIN}/#door/${ADDRESS}`, { onOpenInvite })).toBeNull();
    expect(onOpenInvite).not.toHaveBeenCalled();
  });

  it('reads a card or follow link even where nothing opens one, and opening it then does nothing', () => {
    const onOpenInvite = vi.fn();
    const card = readLink(cardLink(ORIGIN, newCardSeed()), { onOpenInvite });
    const follow = readLink(followLink(ORIGIN, newInviteSeed()), { onOpenInvite });

    expect([card?.kind, follow?.kind]).toEqual(['card', 'follow']);
    card?.open();
    follow?.open();
    expect(onOpenInvite).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing', ''],
    ['words', 'not a link'],
    ['another site', 'https://example.com/whatever'],
    ['a damaged invite', `${ORIGIN}/#join/not-a-real-payload`],
  ])('reads %s as no link', (_name, text) => {
    expect(readLink(text, openers())).toBeNull();
  });

  it('never throws, and reading alone never opens anything', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const open = openers();
        const read = readLink(text, open);
        expect(read === null || ['invite', 'card', 'follow', 'door'].includes(read.kind)).toBe(
          true,
        );
        expect(called(open)).toEqual([]);
      }),
    );
  });
});
