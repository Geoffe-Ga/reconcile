import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from '../engine/event';
import {
  type Invite,
  inviteLink,
  invitePayload,
  newInvite,
  parseInviteLink,
  parseInvitePayload,
} from './invite';

const ID = /^[A-Za-z0-9_-]{43}$/;
const LINK = /^https?:\/\/[^#]+\/#\/join\/[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const anInvite = fc.record({ mailbox: bytes32.map(base64url), secret: bytes32 });

describe('newInvite', () => {
  it('makes a 43-character mailbox id and a 32-byte secret', () => {
    const invite = newInvite();
    expect(invite.mailbox).toMatch(ID);
    expect(invite.secret).toBeInstanceOf(Uint8Array);
    expect(invite.secret).toHaveLength(32);
  });

  it('never repeats itself', () => {
    const a = newInvite();
    const b = newInvite();
    expect(a.mailbox).not.toBe(b.mailbox);
    expect(base64url(a.secret)).not.toBe(base64url(b.secret));
    expect(base64url(a.secret)).not.toBe(a.mailbox);
  });
});

describe('inviteLink', () => {
  it('puts the mailbox and secret after #, joined by a dot', () => {
    const invite = newInvite();
    const link = inviteLink('https://reconcile.example', invite);
    expect(link).toMatch(LINK);
    expect(link).toBe(
      `https://reconcile.example/#/join/${invite.mailbox}.${base64url(invite.secret)}`,
    );
    const [beforeHash] = link.split('#');
    expect(beforeHash).not.toContain(base64url(invite.secret));
    expect(beforeHash).not.toContain(invite.mailbox);
  });
});

describe('parseInvitePayload', () => {
  it('reads back every payload invitePayload writes', () => {
    fc.assert(
      fc.property(anInvite, (invite: Invite) => {
        const parsed = parseInvitePayload(invitePayload(invite));
        expect(parsed?.mailbox).toBe(invite.mailbox);
        expect(Array.from(parsed?.secret ?? [])).toEqual(Array.from(invite.secret));
      }),
    );
  });

  it('refuses anything that is not two 43-character base64url parts', () => {
    const { mailbox, secret } = newInvite();
    const key = base64url(secret);
    for (const payload of [
      '',
      '.',
      mailbox,
      `${mailbox}.`,
      `.${key}`,
      `${mailbox}.${key}.${key}`,
      `${mailbox.slice(1)}.${key}`,
      `${mailbox}.${key.slice(1)}`,
      `${mailbox}x.${key}`,
      `${mailbox}.${key}x`,
      `${mailbox.slice(1)}+.${key}`,
      `${mailbox}.${key.slice(1)}/`,
      `${mailbox}.${key.slice(1)}=`,
    ]) {
      expect(parseInvitePayload(payload), payload).toBeNull();
    }
  });

  it('refuses a secret whose last character carries stray bits', () => {
    const { mailbox, secret } = newInvite();
    // 32 bytes leave 2 spare bits in the 43rd character; 'B' sets one of them.
    const key = base64url(secret.map(() => 0)).slice(0, 42) + 'B';
    expect(parseInvitePayload(`${mailbox}.${key}`)).toBeNull();
    expect(parseInvitePayload(`${mailbox}.${base64url(secret)}`)).not.toBeNull();
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
  ])('reads %s', (_label, text) => {
    expect(parseInviteLink(text)?.mailbox).toBe(invite.mailbox);
  });

  it.each([
    ['empty text', ''],
    ['another page of the app', 'https://reconcile.example/#/create'],
    ['the payload in the path, not after #', `https://reconcile.example/join/${payload}`],
    [
      'a link with the payload cut short',
      `https://reconcile.example/#/join/${payload.slice(0, 60)}`,
    ],
    ['words', 'please join my group'],
  ])('refuses %s', (_label, text) => {
    expect(parseInviteLink(text)).toBeNull();
  });
});
