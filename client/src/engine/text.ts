/**
 * Text helpers shared by the engine and the screens that write events.
 *
 * Lengths are Unicode code points (ADR-0072 item 4). The author normalizes to NFC
 * before signing; the fold counts received text as it arrives and never
 * re-normalizes it, because browsers ship different Unicode tables
 * (docs/spec/phase-1-spec.md §4).
 */

/** Counts the code points in `text` exactly as given. A lone surrogate counts as one. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Counts the code points in `text` after NFC normalization, as a composer's limit does. */
export function nfcLength(text: string): number {
  return codePointLength(text.normalize('NFC'));
}

/**
 * Splits a draft Document into Atoms at blank lines, for Create group.
 *
 * A blank line holds only whitespace. Runs of blank lines count as one break,
 * leading and trailing blank lines are dropped, CRLF and CR become LF, and
 * lines keep their indentation.
 */
export function splitAtoms(text: string): string[] {
  const atoms: string[] = [];
  let lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() !== '') {
      lines.push(line);
    } else if (lines.length > 0) {
      atoms.push(lines.join('\n'));
      lines = [];
    }
  }
  if (lines.length > 0) atoms.push(lines.join('\n'));
  return atoms;
}
