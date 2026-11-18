/**
 * The covenant a listed door accepts (#485; ADR-0081 §3, ADR-0035;
 * docs/spec/listed-doors.md §3.2).
 *
 * The text ships with the app, versioned. A listing carries the SHA-256 of
 * the text its group voted on, so a group's vote names exact words, and
 * covenant.test.ts pins each version's hash: the words of a version never
 * change. A new version is a new text, a new hash and a new version number,
 * and a group accepts it by an ordinary rules Proposal.
 *
 * This is the pilot draft, and every screen that shows it says so. Its first
 * clause is ADR-0035's placeholder for the eternal core, word for word; the
 * wording of the whole waits on ADR-0035 and on counsel.
 */
import { base64url } from '../crypto/base64url';
import { sha256 } from '../crypto/hash';

/** One version of the covenant, as the app carries it. */
export interface Covenant {
  /** Its version, counted from 1. */
  readonly version: number;
  /** True while its wording is a draft, which every screen that shows it says. */
  readonly draft: boolean;
  /** Its clauses, in order. */
  readonly clauses: readonly string[];
  /** What a group reads and votes on: each clause numbered, one to a line. */
  readonly text: string;
  /** The SHA-256 of `text`'s UTF-8, in unpadded base64url: what a listing carries. */
  readonly hash: string;
}

/**
 * The pilot draft's clauses: C1, ADR-0035's placeholder core, verbatim; C2,
 * no spam; C3, no impersonation of another group or person.
 */
export const COVENANT_CLAUSES: readonly string[] = [
  "Reconcile does not carry calls for violence against people, or speech that denies any group's humanity.",
  'A listed group does not post spam.',
  'A listed group does not pretend to be another group or person.',
];

/** The SHA-256 of `text`'s UTF-8, in unpadded base64url. */
export function covenantHash(text: string): string {
  return base64url(sha256(new TextEncoder().encode(text)));
}

/** The text a group reads: each clause numbered, one to a line. */
function textOf(clauses: readonly string[]): string {
  return clauses.map((clause, i) => `${String(i + 1)}. ${clause}`).join('\n');
}

/** The covenant's current version, which a new listing accepts. */
export const COVENANT_VERSION = 1;

const TEXT = textOf(COVENANT_CLAUSES);

/** The covenant this app offers a group to accept: version 1, the pilot draft. */
export const COVENANT: Covenant = {
  version: COVENANT_VERSION,
  draft: true,
  clauses: COVENANT_CLAUSES,
  text: TEXT,
  hash: covenantHash(TEXT),
};

/** The current version's hash, which a listing Proposal carries. */
export const COVENANT_HASH = COVENANT.hash;

/**
 * The covenant this app carries whose hash is `hash`, or null for any other
 * hash: one from a newer app, or none. A screen shows a covenant's words only
 * when they are the words the hash names.
 */
export function covenantOf(hash: unknown): Covenant | null {
  return hash === COVENANT_HASH ? COVENANT : null;
}
