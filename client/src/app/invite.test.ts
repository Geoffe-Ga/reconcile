import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deriveWeekMailboxId } from '../crypto/groupKeys';
import { deriveInviteMailboxId, newInviteSeed } from '../crypto/invite';
import { base64url } from '../engine/event';
import { inviteLink, parseInviteLink, parseInvitePayload } from './invite';

/** The form the issue pins: the origin, then `#join/` and 43 base64url characters. */
const LINK = /^https?:\/\/[^#]+\/#join\/[A-Za-z0-9_-]{43}$/;

const seeds = fc.uint8Array({ minLength: 32, maxLength: 32 });

describe('inviteLink', () => {
  it('puts only the seed after #, and no mailbox id anywhere', () => {
    const seed = newInviteSeed();
    const link = inviteLink('https://reconcile.example', seed);
    expect(link).toMatch(LINK);
    expect(link).toBe(`https://reconcile.example/#join/${base64url(seed)}`);
    const [beforeHash] = link.split('#');
    expect(beforeHash).not.toContain(base64url(seed));
    expect(link).not.toContain(deriveInviteMailboxId(seed));
    expect(link).not.toContain(deriveWeekMailboxId(seed, 2963));
  });
});

describe('parseInvitePayload', () => {
  it('reads back every seed a link carries', () => {
    fc.assert(
      fc.property(seeds, (seed) => {
        expect(Array.from(parseInvitePayload(base64url(seed)) ?? [])).toEqual(Array.from(seed));
      }),
    );
  });

  it('refuses anything that is not one 43-character base64url seed', () => {
    const key = base64url(newInviteSeed());
    for (const payload of [
      '',
      '.',
      key.slice(1),
      `${key}x`,
      `${key}.`,
      `${key}.${key}`,
      `${key.slice(1)}+`,
      `${key.slice(1)}/`,
      `${key.slice(1)}=`,
    ]) {
      expect(parseInvitePayload(payload), payload).toBeNull();
    }
  });

  it('refuses a seed whose last character carries stray bits', () => {
    // 32 bytes leave 2 spare bits in the 43rd character; 'B' sets one of them.
    expect(parseInvitePayload(`${'A'.repeat(42)}B`)).toBeNull();
    expect(parseInvitePayload(`${'A'.repeat(42)}E`)).not.toBeNull();
  });
});

describe('parseInviteLink', () => {
  const seed = newInviteSeed();
  const payload = base64url(seed);

  it.each([
    ['a link from this app', `https://reconcile.example/#join/${payload}`],
    ['a link from a dev server', `http://localhost:5173/#join/${payload}`],
    ['a link with spaces around it', `  https://reconcile.example/#join/${payload}\n`],
    ['a link in the tracer’s #/join/ form', `https://reconcile.example/#/join/${payload}`],
    ['the bare seed', payload],
    ['the bare seed with spaces around it', ` ${payload} `],
  ])('reads %s', (_label, text) => {
    expect(base64url(parseInviteLink(text) ?? new Uint8Array())).toBe(payload);
  });

  it.each([
    ['empty text', ''],
    ['another page of the app', 'https://reconcile.example/#/create'],
    ['the seed in the path, not after #', `https://reconcile.example/join/${payload}`],
    ['a link with the seed cut short', `https://reconcile.example/#join/${payload.slice(0, 40)}`],
    [
      'a link in the old mailbox.secret form',
      `https://reconcile.example/#join/${payload}.${payload}`,
    ],
    ['words', 'please join my group'],
  ])('refuses %s', (_label, text) => {
    expect(parseInviteLink(text)).toBeNull();
  });
});
