/**
 * What a pasted link is (#444; ADR-0077 §6): link in, kind and payload out,
 * with no field around it. Every link the app makes reads back as its own
 * kind, as a whole link from any origin or its bare fragment, with any
 * whitespace or words around it as a chat app copies it; one with its
 * payload cut short reads as damaged; anything else is no link at all.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cardLink } from '../coalition/card';
import { followLink } from '../coalition/follow';
import { newCardSeed } from '../crypto/card';
import { base64url } from '../crypto/base64url';
import { newInviteSeed } from '../crypto/invite';
import { linkCode, newLinkKeys, newLinkSeed } from '../crypto/link';
import { newRecoveryKeys, recoveryCode } from '../crypto/recovery';
import { doorLinkOf } from '../door/page';
import { voteToken } from '../crypto/voteLink';
import { shareLinkOf } from '../share/shareLink';
import { inviteLink } from './invite';
import { type LinkKindName, linkKind } from './linkKind';
import { voteLinkOf } from './voteLink';

const ORIGIN = 'https://reconcile.example';

/** Each kind of link the app makes, from an origin and two 32-byte values. */
const MAKERS: Readonly<
  Record<LinkKindName, (origin: string, a: Uint8Array, b: Uint8Array) => string>
> = {
  invite: (origin, seed) => inviteLink(origin, seed),
  card: (origin, seed) => cardLink(origin, seed),
  follow: (origin, seed) => followLink(origin, seed),
  door: (origin, address) => doorLinkOf(origin, address),
  shared: (origin, seed, publicKey) => shareLinkOf(origin, { seed, publicKey }),
  // A vote link (#472): a group's secret and a Proposal's id make its token.
  vote: (origin, secret, proposal) => voteLinkOf(origin, voteToken(secret, base64url(proposal))),
};

const KINDS = Object.keys(MAKERS) as LinkKindName[];

/** A link the app makes, its kind, and what follows its fragment's prefix. */
const madeLink = fc
  .record({
    kind: fc.constantFrom(...KINDS),
    origin: fc.constantFrom(ORIGIN, 'https://app.example', 'http://localhost:5173'),
    a: fc.uint8Array({ minLength: 32, maxLength: 32 }),
    b: fc.uint8Array({ minLength: 32, maxLength: 32 }),
    bare: fc.boolean(),
  })
  .map(({ kind, origin, a, b, bare }) => {
    const full = MAKERS[kind](origin, a, b);
    const fragment = new URL(full).hash;
    const payload = fragment.slice(fragment.indexOf('/') + 1);
    return { kind, payload, link: bare ? fragment : full };
  });

/** Whitespace as pasting leaves it: spaces, tabs and line breaks. */
const blank = fc.stringMatching(/^[ \t\r\n]{0,4}$/);

/** Words a chat app copies around a link. */
const words = fc
  .array(fc.constantFrom('hey,', 'join', 'us', 'here’s', 'the', 'link:', 'thanks!', '🙂'), {
    maxLength: 4,
  })
  .map((list) => list.join(' '));

describe('linkKind', () => {
  it('reads every link the app makes back as its kind and payload, whatever is around it', () => {
    fc.assert(
      fc.property(madeLink, blank, words, words, blank, (made, lead, before, after, trail) => {
        const text = `${lead}${before} ${made.link} ${after}${trail}`;
        expect(linkKind(text)).toEqual({ kind: made.kind, payload: made.payload });
      }),
    );
  });

  it.each([
    ['in angle brackets', (link: string) => `<${link}>`],
    ['in parentheses', (link: string) => `(${link})`],
    ['at the end of a sentence', (link: string) => `Join us at ${link}.`],
    ['in quotes', (link: string) => `“${link}”`],
  ])('reads a link %s, as chat apps copy them', (_name, wrap) => {
    const seed = newInviteSeed();
    const link = inviteLink(ORIGIN, seed);
    const payload = new URL(link).hash.slice('#join/'.length);

    expect(linkKind(wrap(link))).toEqual({ kind: 'invite', payload });
  });

  it('reads a vote link as a vote, and one whose token isn’t 22 base64url characters as damaged (#472)', () => {
    const token = voteToken(new Uint8Array(32).fill(7), base64url(new Uint8Array(32)));

    expect(linkKind(`vote today! https://app.example/#vote/${token}`)).toEqual({
      kind: 'vote',
      payload: token,
    });
    expect(linkKind(`#vote/${token}`)).toEqual({ kind: 'vote', payload: token });
    expect(linkKind(`https://app.example/#vote/${token}x`)).toEqual({ kind: 'damaged' });
    expect(linkKind(`https://app.example/#vote/${token.slice(0, 21)}=`)).toEqual({
      kind: 'damaged',
    });
    expect(linkKind('https://app.example/#vote/')).toEqual({ kind: 'damaged' });
  });

  it('reads the first link that opens, past a damaged one before it', () => {
    const card = cardLink(ORIGIN, newCardSeed());
    const payload = new URL(card).hash.slice('#reconcile/'.length);

    expect(linkKind(`${ORIGIN}/#join/cut ${card}`)).toEqual({ kind: 'card', payload });
  });

  it('reads any link the app makes, cut short anywhere in its payload, as damaged', () => {
    fc.assert(
      fc.property(madeLink, fc.nat(), (made, at) => {
        const cut = made.link.slice(0, made.link.length - 1 - (at % made.payload.length));
        expect(linkKind(cut)).toEqual({ kind: 'damaged' });
      }),
    );
  });

  it.each([
    ['a linking code', () => linkCode(newLinkSeed(), newLinkKeys().publicKey), 'linking-code'],
    ['a recovery code', () => recoveryCode(newRecoveryKeys()), 'recovery-code'],
  ] as const)(
    'reads %s, with words around it, by its kind alone, carrying none of it',
    (_name, make, kind) => {
      expect(linkKind(`here’s my code:\n${make()} thanks`)).toEqual({ kind });
    },
  );

  it.each([
    ['RL1.', 'linking-code'],
    ['RR1.', 'recovery-code'],
  ] as const)('reads a code by its prefix %s alone, cut short or not', (prefix, kind) => {
    expect(linkKind(prefix)).toEqual({ kind });
    expect(linkKind(`${prefix}abc`)).toEqual({ kind });
  });

  it.each([
    ['nothing', ''],
    ['blank space', ' \n\t '],
    ['words', 'quiet hours'],
    ['another site', 'https://example.com/whatever'],
    ['another site’s fragment', 'https://example.com/#top'],
    ['one of the app’s own pages', `${ORIGIN}/#/g/abc`],
    ['a bare seed, which names no kind', base64url(newInviteSeed())],
    ['a fragment with no payload', '#join'],
  ])('reads %s as no link', (_name, text) => {
    expect(linkKind(text)).toEqual({ kind: 'not-a-link' });
  });

  it('never throws, and reads anything as a kind, damaged or no link', () => {
    const names: readonly string[] = [
      ...KINDS,
      'linking-code',
      'recovery-code',
      'damaged',
      'not-a-link',
    ];
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(names).toContain(linkKind(text).kind);
      }),
    );
  });
});
