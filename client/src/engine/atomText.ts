/**
 * Atom text (ADR-0023, docs/spec/phase-1-spec.md §4): the one normalizer every
 * author runs before signing, and the genesis split that uses it.
 *
 * Every device that signs an Atom's text signs the same bytes for the same
 * words, however they were typed or pasted. The fold never runs this on text it
 * receives: browsers ship different Unicode tables, so re-normalizing there
 * could make two devices fold different Documents.
 */
import { splitAtoms } from './text';

/** A surrogate pair, or a lone surrogate of either half. */
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/** The Unicode replacement character, which stands in for a lone surrogate. */
const REPLACEMENT = '�';

/** Spaces (U+0020) and tabs (U+0009) at the end of a line. Never `\s`, which also takes NBSP. */
const TRAILING_SPACES = /[ \t]+$/gm;

/** Every line feed at the very end. */
const FINAL_NEWLINES = /\n+$/;

/** Replaces each lone surrogate with U+FFFD, keeping whole pairs, so the text encodes as UTF-8. */
function wellFormed(text: string): string {
  return text.replace(SURROGATES, (match) => (match.length === 2 ? match : REPLACEMENT));
}

/**
 * Normalizes an Atom's text before it is signed, in this order:
 *
 * 1. each lone surrogate becomes U+FFFD;
 * 2. CRLF, then any lone CR, becomes LF;
 * 3. NFC;
 * 4. trailing U+0020 and U+0009 leave each line (a trailing NBSP stays);
 * 5. the text ends in exactly one LF.
 *
 * Blank text becomes `""`, which a removal Proposal carries (#75). The result
 * is idempotent: normalizing it again changes nothing.
 */
export function normalizeAtomText(text: string): string {
  const body = wellFormed(text)
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(TRAILING_SPACES, '')
    .replace(FINAL_NEWLINES, '');
  return body === '' ? '' : `${body}\n`;
}

/**
 * A header's level as Add a section here offers it (#103): 1 for a section
 * header, `# …`, and 2 for a subsection header, `## …`.
 */
export type HeadingLevel = 1 | 2;

/**
 * One ATX heading of level 1–6 with a word in it, on one line that ends the
 * text (ADR-0023): CommonMark needs the space after the `#`s.
 */
const HEADING_ONLY = /^#{1,6} [^\n]*\S[^\n]*\n$/u;

/**
 * True when normalized Atom text is a section header and nothing more (#103):
 * one line, `# Values\n` or `## Organization\n`, as Add a section here's
 * header choices build it. The fold treats a header as any other Atom; the
 * screens read this to show it as a header and to say what an add does.
 */
export function isHeadingOnly(text: string): boolean {
  return HEADING_ONLY.test(text);
}

/**
 * Splits a founding Document into its Atoms at blank lines (`splitAtoms`),
 * then normalizes each one, so every genesis Atom ends in one LF.
 */
export function genesisAtoms(document: string): string[] {
  return splitAtoms(document).map(normalizeAtomText);
}
