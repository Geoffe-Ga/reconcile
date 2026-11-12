/**
 * A protected section's badge (#116; DESIGN.md, Atom block): an eyebrow in
 * the section's gutter that says its class in words, so color is never the
 * only signal. An entrenched section's has a `clay` outline and a lock glyph,
 * and an eternal section's a double `ink` rule. An ordinary section has none.
 */
import type { AtomClass } from '../engine/rules';
import { messages } from './messages';

/** A small padlock, drawn in the badge's own color; the word beside it carries the meaning. */
function LockGlyph() {
  return (
    <svg
      className="atom-badge-glyph"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M5 7V5a3 3 0 0 1 6 0v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/** Props for {@link AtomBadge}. */
export interface AtomBadgeProps {
  /** The section's class, from the fold. */
  readonly cls: AtomClass;
}

/** "Entrenched", with its lock, or "Eternal", over a protected section's text; nothing for an ordinary one. */
export function AtomBadge({ cls }: AtomBadgeProps) {
  const { atomBadge } = messages;
  if (cls === 'ordinary') return null;
  if (cls === 'eternal') {
    return <p className="eyebrow atom-badge atom-badge-eternal">{atomBadge.eternal}</p>;
  }
  return (
    <p className="eyebrow atom-badge atom-badge-entrenched">
      <LockGlyph />
      {atomBadge.entrenched}
    </p>
  );
}
