import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deriveMailboxId, newGroupSecret } from '../crypto/groupKeys';
import { base64url } from '../engine/event';
import {
  type Invite,
  inviteLink,
  invitePayload,
  parseInviteLink,
  parseInvitePayload,
} from './invite';

const LINK = /^https?:\/\/[^#]+\/#\/join\/[A-Za-z0-9_-]{43}$/;

const anInvite = fc.record({ secret: fc.uint8Array({ minLength: 32, maxLength: 32 }) });

/** An invite to a new group. */
function newInvite(): Invite {
  return { secret: newGroupSecret() };
}

describe('inviteLink', () => {
  it('puts the group secret after #, and no mailbox id anywhere', () => {
    const invite = newInvite();
    const link = inviteLink('https://reconcile.example', invite);
    expect(link).toMatch(LINK);
    expect(link).toBe(`https://reconcile.example/#/join/${base64url(invite.secret)}`);
    const [beforeHash] = link.split('#');
    expect(beforeHash).not.toContain(base64url(invite.secret));
    expect(link).not.toContain(deriveMailboxId(invite.secret));
  });
});

describe('parseInvitePayload', () => {
  it('reads back every payload invitePayload writes', () => {
    fc.assert(
      fc.property(anInvite, (invite: Invite) => {
        const parsed = parseInvitePayload(invitePayload(invite));
        expect(Array.from(parsed?.secret ?? [])).toEqual(Array.from(invite.secret));
      }),
    );
  });

  it('refuses anything that is not one 43-character base64url secret', () => {
    const key = base64url(newGroupSecret());
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

  it('refuses a secret whose last character carries stray bits', () => {
    const secret = newGroupSecret();
    // 32 bytes leave 2 spare bits in the 43rd character; 'B' sets one of them.
    const key = base64url(secret.map(() => 0)).slice(0, 42) + 'B';
    expect(parseInvitePayload(key)).toBeNull();
    expect(parseInvitePayload(base64url(secret))).not.toBeNull();
  });
});

describe('parseInviteLink', () => {
  const invite = newInvite();
  const payload = invitePayload(invite);

  it.each([
    ['a link from this app', `https://reconcile.example/#/join/${payload}`],
    ['a link from a dev server', `http://localhost:5173/#/join/${payload}`],
    ['a link with spaces around it', `  https://reconcile.example/#/join/${payload}\n`],
    ['the bare payload', payload],
    ['the bare payload with spaces around it', `  ${payload}\n`],
  ])('reads %s', (_label, text) => {
    expect(base64url(parseInviteLink(text)?.secret ?? new Uint8Array())).toBe(payload);
  });

  it.each([
    ['empty text', ''],
    ['another page of the app', 'https://reconcile.example/#/create'],
    ['the payload in the path, not after #', `https://reconcile.example/join/${payload}`],
    [
      'a link with the payload cut short',
      `https://reconcile.example/#/join/${payload.slice(0, 40)}`,
    ],
    [
      'a link in the old mailbox.secret form',
      `https://reconcile.example/#/join/${payload}.${payload}`,
    ],
    ['words', 'please join my group'],
  ])('refuses %s', (_label, text) => {
    expect(parseInviteLink(text)).toBeNull();
  });
});
