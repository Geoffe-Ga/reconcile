/**
 * A vote link's token (#472, ADR-0079 §1): HKDF of the group's secret under
 * its own label and the Proposal's id, its first 16 bytes in unpadded
 * base64url. `vectors/vote-link.json`, computed with Node's own `crypto`,
 * pins it outside @noble; the properties pin that every device of one group
 * agrees, and that one Proposal's tokens in two groups have nothing in common.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from './base64url';
import {
  VOTE_LINK_LABEL,
  VOTE_TOKEN,
  VOTE_TOKEN_LENGTH,
  voteLinkInfo,
  voteToken,
} from './voteLink';

/** `vectors/vote-link.json`: each secret, Proposal id and token is its bytes. */
interface VoteLinkFile {
  readonly kind: 'vote-link';
  readonly label: string;
  readonly vectors: readonly {
    readonly name: string;
    readonly secret: readonly number[];
    readonly proposal: readonly number[];
    readonly token: readonly number[];
  }[];
}

const [file] = Object.values(
  import.meta.glob<VoteLinkFile>('./vectors/vote-link.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/vote-link.json is missing.');

/** A 32-byte group secret. */
const secret = fc.uint8Array({ minLength: 32, maxLength: 32 });

/** A Proposal's event id, as the event spells it: 32 bytes in unpadded base64url. */
const proposalId = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((bytes) => base64url(bytes));

describe('vote-link.json (#472)', () => {
  it('names the label, and the info as the label, a 0x00 byte and the Proposal id', () => {
    expect(file.kind).toBe('vote-link');
    expect(file.label).toBe(VOTE_LINK_LABEL);
    expect(VOTE_LINK_LABEL).toBe('reconcile/v1/vote-link');
    const id = 'A'.repeat(43);
    expect([...voteLinkInfo(id)]).toEqual([
      ...new TextEncoder().encode('reconcile/v1/vote-link'),
      0,
      ...new TextEncoder().encode(id),
    ]);
  });

  it('holds one Proposal id under two secrets, as one coalition motion in two groups', () => {
    const byProposal = new Map<string, Set<string>>();
    for (const vector of file.vectors) {
      const key = base64url(Uint8Array.from(vector.proposal));
      const secrets = byProposal.get(key) ?? new Set<string>();
      secrets.add(base64url(Uint8Array.from(vector.secret)));
      byProposal.set(key, secrets);
    }
    expect([...byProposal.values()].some((secrets) => secrets.size >= 2)).toBe(true);
  });

  it.each(file.vectors.map((vector) => [vector.name, vector] as const))(
    'gives the token Node gives: %s',
    (_name, vector) => {
      const groupSecret = Uint8Array.from(vector.secret);
      const proposal = base64url(Uint8Array.from(vector.proposal));
      expect(voteToken(groupSecret, proposal)).toBe(base64url(Uint8Array.from(vector.token)));
    },
  );
});

describe('voteToken (#472)', () => {
  it('is 22 base64url characters, and the same on every device that holds the secret', () => {
    expect(VOTE_TOKEN_LENGTH).toBe(22);
    fc.assert(
      fc.property(secret, proposalId, (groupSecret, proposal) => {
        const token = voteToken(groupSecret, proposal);
        expect(token).toHaveLength(VOTE_TOKEN_LENGTH);
        expect(VOTE_TOKEN.test(token)).toBe(true);
        // Another device, with its own copy of the secret, gets the same.
        expect(voteToken(Uint8Array.from(groupSecret), proposal)).toBe(token);
      }),
    );
  });

  it('gives one Proposal another token under another group’s secret, and another Proposal another token', () => {
    fc.assert(
      fc.property(secret, secret, proposalId, proposalId, (a, b, p, q) => {
        fc.pre(base64url(a) !== base64url(b) && p !== q);
        const token = voteToken(a, p);
        expect(voteToken(b, p)).not.toBe(token);
        expect(voteToken(a, q)).not.toBe(token);
      }),
    );
  });

  it('reads only 22 unpadded base64url characters as a token', () => {
    expect(VOTE_TOKEN.test('A'.repeat(22))).toBe(true);
    expect(VOTE_TOKEN.test('a-_9'.repeat(5) + 'Zz')).toBe(true);
    expect(VOTE_TOKEN.test('A'.repeat(21))).toBe(false);
    expect(VOTE_TOKEN.test('A'.repeat(23))).toBe(false);
    expect(VOTE_TOKEN.test('A'.repeat(21) + '=')).toBe(false);
    expect(VOTE_TOKEN.test('A'.repeat(21) + '+')).toBe(false);
  });

  it('refuses a secret that isn’t 32 bytes, and an id that isn’t an event id', () => {
    const proposal = base64url(new Uint8Array(32));
    expect(() => voteToken(new Uint8Array(31), proposal)).toThrow('A group secret is 32 bytes.');
    expect(() => voteToken(new Uint8Array(32), 'not an id')).toThrow(
      'A vote link needs a Proposal’s event id.',
    );
  });
});
