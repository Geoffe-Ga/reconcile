/**
 * Opening a link from the link bar (#444): each kind through its own page,
 * a seed held in memory and never in the address bar, a front door's and a
 * shared Document's payload in the address bar as their own links put it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newInviteSeed } from '../crypto/invite';
import { openPasted } from './openPasted';

afterEach(() => {
  window.history.replaceState(null, '', '#/');
});

describe('openPasted', () => {
  it.each([
    ['an invite', 'invite', '#/join'],
    ['a reconcile card', 'card', '#/card'],
    ['a follow link', 'follow', '#/follow'],
  ] as const)(
    'opens %s with its seed held in memory, out of the address bar',
    (_name, kind, hash) => {
      const seed = newInviteSeed();
      const holdSeed = vi.fn();

      openPasted({ kind, payload: base64url(seed) }, holdSeed);

      expect(holdSeed).toHaveBeenCalledTimes(1);
      expect(Array.from(holdSeed.mock.calls[0]?.[0] as Uint8Array)).toEqual(Array.from(seed));
      expect(window.location.hash).toBe(hash);
    },
  );

  it.each([
    ['a front door', 'door', '#door/'],
    ['a shared Document', 'shared', '#share/'],
    ['a vote (#472)', 'vote', '#vote/'],
  ] as const)('opens %s at its own link, holding nothing', (_name, kind, prefix) => {
    const holdSeed = vi.fn();

    openPasted({ kind, payload: 'payload' }, holdSeed);

    expect(window.location.hash).toBe(`${prefix}payload`);
    expect(holdSeed).not.toHaveBeenCalled();
  });

  it('opens nothing for a seed that doesn’t read', () => {
    const holdSeed = vi.fn();

    openPasted({ kind: 'invite', payload: 'cut' }, holdSeed);

    expect(holdSeed).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/');
  });
});
