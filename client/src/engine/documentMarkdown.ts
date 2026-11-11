/**
 * A Document as one Markdown text (#75; ADR-0010, ADR-0023): what Copy as
 * Markdown puts on the clipboard, so a group can carry its Document into a
 * fresh group, which is how it starts over.
 *
 * Every Atom's text already ends in exactly one LF (`normalizeAtomText`), so
 * joining them with one more LF leaves a blank line between sections. Create
 * group splits pasted text into Atoms at blank lines, so pasting the result
 * there gives back the same sections, unless one of them holds a blank line
 * of its own, which then splits in two.
 */

/** The Atoms' texts joined by `"\n"`, in Document order. */
export function documentToMarkdown(atoms: readonly { readonly text: string }[]): string {
  return atoms.map((atom) => atom.text).join('\n');
}
