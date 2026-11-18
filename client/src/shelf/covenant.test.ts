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
 * Each version's hash, pinned. Changing the text without a new version fails
 * here: a group voted on the words its hash names, so the words for that
 * version never change. A new version adds its hash below.
 */
const PINNED: Readonly<Record<number, string>> = {
  1: '2zkzlHq8H15g0ZYWGc6Q5urw5FCgRjbzY8dw3-WfPXo',
};

describe('the covenant a listing accepts (ADR-0081 §3)', () => {
  it('pins each version’s hash, so the text never changes without a new version', () => {
    expect(PINNED[COVENANT_VERSION]).toBe(COVENANT_HASH);
    expect(covenantHash(COVENANT.text)).toBe(PINNED[COVENANT_VERSION]);
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
