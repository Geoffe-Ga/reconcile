/**
 * Word diffs for the ballot (ADR-0073, DESIGN.md "Ballot"): what a Proposal
 * changes, word by word, in the Atom's Markdown source.
 *
 * It diffs the source text as signed, never rendered HTML, so a voter sees
 * every character that would change, link targets included.
 */
import { diffWordsWithSpace } from 'diff';

/** One run of a diff: text both versions share, text only the new one adds, or text it removes. */
export type DiffPart =
  { readonly same: string } | { readonly added: string } | { readonly removed: string };

/**
 * The most word and space edits a diff works out. Past this the change is a
 * rewrite, shown as the old text removed and the new text added, so a long
 * rewrite never stalls the screen.
 */
export const MAX_DIFF_EDITS = 1_000;

/** The old text removed and the new text added, leaving out an empty side. */
function rewrite(current: string, proposed: string): DiffPart[] {
  return [
    ...(current === '' ? [] : [{ removed: current }]),
    ...(proposed === '' ? [] : [{ added: proposed }]),
  ];
}

/**
 * The word diff from `current` to `proposed`, by jsdiff's diffWordsWithSpace:
 * runs of shared, added and removed text, in order. The shared and added runs
 * rebuild `proposed`; the shared and removed runs rebuild `current`.
 */
export function wordDiff(current: string, proposed: string): DiffPart[] {
  const changes = diffWordsWithSpace(current, proposed, { maxEditLength: MAX_DIFF_EDITS });
  if (changes === undefined) return rewrite(current, proposed);
  return changes.map(({ value, added, removed }): DiffPart => {
    if (added) return { added: value };
    if (removed) return { removed: value };
    return { same: value };
  });
}
