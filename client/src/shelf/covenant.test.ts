/**
 * The covenant a listing accepts (#485; ADR-0081 §3; docs/spec/listed-doors.md
 * §3.2): its draft text, its version and the hash a listing carries.
 */
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { sha256 } from '../crypto/hash';
import {
  COVENANT,
  COVENANT_CLAUSES,
  COVENANT_HASH,
  COVENANT_VERSION,
  covenantHash,
  covenantOf,
} from './covenant';

/**
 * Each version's hash, pinned as its 32 bytes, so no high-entropy text sits in
 * the repository. Changing the text without a new version fails here: a group
 * voted on the words its hash names, so the words for that version never
 * change. A new version adds its hash below.
 */
const PINNED: Readonly<Record<number, readonly number[]>> = {
  1: [
    219, 57, 51, 148, 122, 188, 31, 94, 96, 209, 150, 22, 25, 206, 144, 230, 234, 240, 228, 80, 160,
    70, 54, 243, 99, 199, 112, 223, 229, 159, 61, 122,
  ],
};

/** Version `version`'s pinned hash in unpadded base64url, as a listing carries it. */
function pinned(version: number): string | undefined {
  const bytes = PINNED[version];
  return bytes === undefined ? undefined : base64url(Uint8Array.from(bytes));
}

describe('the covenant a listing accepts (ADR-0081 §3)', () => {
  it('pins each version’s hash, so the text never changes without a new version', () => {
    expect(pinned(COVENANT_VERSION)).toBe(COVENANT_HASH);
    expect(covenantHash(COVENANT.text)).toBe(pinned(COVENANT_VERSION));
  });

  it('hashes the UTF-8 of the text with SHA-256, in unpadded base64url', () => {
    const bytes = new TextEncoder().encode(COVENANT.text);
    expect(COVENANT_HASH).toBe(base64url(sha256(bytes)));
    expect(COVENANT_HASH).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is the pilot draft: ADR-0035’s placeholder core, then no spam, then no impersonation', () => {
    expect(COVENANT.draft).toBe(true);
    expect(COVENANT_CLAUSES).toEqual([
      "Reconcile does not carry calls for violence against people, or speech that denies any group's humanity.",
      'A listed group does not post spam.',
      'A listed group does not pretend to be another group or person.',
    ]);
    expect(COVENANT.text).toBe(
      COVENANT_CLAUSES.map((clause, i) => `${String(i + 1)}. ${clause}`).join('\n'),
    );
  });

  it('gives the covenant this app carries for a hash, and null for any other', () => {
    expect(covenantOf(COVENANT_HASH)).toBe(COVENANT);
    expect(covenantOf(base64url(new Uint8Array(32)))).toBeNull();
    expect(covenantOf(undefined)).toBeNull();
  });
});
