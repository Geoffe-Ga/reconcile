/**
 * The founding Document's sections as Join shows them before anyone joins
 * (#91; ADR-0052: "Reconcile user with Group"), under the preview card's
 * title in place of its excerpt.
 *
 * `foldInvite` builds them in memory from the invite's envelope, each with its
 * current text. Every section renders through `<AtomText>`, the one sanitizing
 * renderer (ADR-0023), read only, in the document style: nothing here is ever
 * read as HTML, links stay within http(s) and mailto, and nothing loads.
 */
import type { Atom } from '../engine/fold';
import { AtomText } from './text/AtomText';

/** Props for {@link InviteDocument}. */
export interface InviteDocumentProps {
  /** The genesis Document's Atoms, folded from the invite's entries. */
  readonly atoms: readonly Atom[];
}

/** Every section of the Document as it reads now, read only. */
export function InviteDocument({ atoms }: InviteDocumentProps) {
  return (
    <article className="document">
      {atoms.map((atom) => (
        <div key={atom.id} className="atom">
          <AtomText text={atom.text} />
        </div>
      ))}
    </article>
  );
}
