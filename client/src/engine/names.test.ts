import { describe, expect, it } from 'vitest';

import { newSigningKeys } from '../crypto/sign';
import { base64url } from './event';
import { displayName, NAME_SUFFIX_SEPARATOR } from './names';
import { DEFAULT_JOIN_LEVEL, type Level } from './capabilities';

/** A fresh member's author key. */
function freshKey(): string {
  return base64url(newSigningKeys().publicKey);
}

/** A roster of members with these names, each under a fresh key. */
function roster(...names: string[]): {
  members: { author: string; name: string; level: Level; seq: number }[];
} {
  return {
    members: names.map((name, seq) => ({
      author: freshKey(),
      name,
      level: DEFAULT_JOIN_LEVEL,
      seq,
    })),
  };
}

/** The first 4 hex characters of the SHA-256 of the key's 32 bytes, by WebCrypto. */
async function expectedSuffix(author: string): Promise<string> {
  const binary = atob(author.replace(/-/g, '+').replace(/_/g, '/'));
  const key = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
  return Array.from(digest.subarray(0, 2), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The keys of a roster's members, in order. */
function keys(state: ReturnType<typeof roster>): string[] {
  return state.members.map((member) => member.author);
}

describe('displayName', () => {
  it('separates a name from its suffix with a spaced middle dot', () => {
    expect(NAME_SUFFIX_SEPARATOR).toBe(' · ');
  });

  it('shows a name no other member shares as it is', () => {
    const state = roster('Sam', 'Sammy', 'Ana');
    expect(keys(state).map((key) => displayName(state, key))).toEqual(['Sam', 'Sammy', 'Ana']);
  });

  it('adds a key suffix to "Sam" and "sam ", which match after trimming and lower-casing', async () => {
    const state = roster('Sam', 'sam ', 'Ana');
    const [sam, other, ana] = keys(state) as [string, string, string];
    expect(displayName(state, sam)).toBe(`Sam · ${await expectedSuffix(sam)}`);
    expect(displayName(state, other)).toBe(`sam  · ${await expectedSuffix(other)}`);
    expect(displayName(state, ana)).toBe('Ana');
  });

  it('matches names after NFC, so a composed and a decomposed é are the same name', async () => {
    const state = roster('José', 'JOSÉ');
    const [one, two] = keys(state) as [string, string];
    expect(displayName(state, one)).toBe(`José · ${await expectedSuffix(one)}`);
    expect(displayName(state, two)).toBe(`JOSÉ · ${await expectedSuffix(two)}`);
  });

  it('compares in lower case, as the spec says: "Straße" and "STRASSE" differ', () => {
    // Upper-casing would turn ß into SS and make the two match.
    const state = roster('Straße', 'STRASSE');
    expect(keys(state).map((key) => displayName(state, key))).toEqual(['Straße', 'STRASSE']);
  });

  it('uses 4 lower-case hex characters', () => {
    const state = roster('Kim', 'kim');
    const [one, two] = keys(state).map((key) => displayName(state, key)?.slice('Kim · '.length));
    expect(one).toMatch(/^[0-9a-f]{4}$/);
    expect(two).toMatch(/^[0-9a-f]{4}$/);
  });

  it('gives no name for a key that isn’t a member', () => {
    expect(displayName(roster('Sam'), freshKey())).toBeNull();
  });
});
