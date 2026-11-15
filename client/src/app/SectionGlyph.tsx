/**
 * Section glyphs (DESIGN.md "Section glyphs"): a small line glyph before each
 * Group home section's eyebrow, so sections that all look alike are told
 * apart at a glance. Each is decorative: hidden from assistive tech, with the
 * heading's words its whole name, and drawn in the eyebrow's own `muted`
 * through `currentColor`, so nothing rests on color or on the glyph alone.
 */
import type { ReactNode } from 'react';

import type { SectionGlyphKind } from './sectionGlyphs';

/** What each kind draws, on a 24-unit grid. */
const DRAWN: Readonly<Record<SectionGlyphKind, ReactNode>> = {
  // A ballot box, a checked card going in: Needs your vote.
  vote: (
    <>
      <path d="M9 12V4h6v8" />
      <path d="m10.5 8 1.2 1.2 1.8-2.2" />
      <rect x="4" y="12" width="16" height="8" rx="1" />
    </>
  ),
  // A target: the group's current focus.
  focus: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  // An hourglass: Proposals whose window is still open.
  open: (
    <>
      <path d="M7 3.5h10M7 20.5h10" />
      <path d="M8 3.5c0 4 4 5 4 8.5s-4 4.5-4 8.5M16 3.5c0 4-4 5-4 8.5s4 4.5 4 8.5" />
    </>
  ),
  // An envelope: Dispatches.
  dispatches: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="1.5" />
      <path d="m3.5 6.5 8.5 6.5 8.5-6.5" />
    </>
  ),
  // A page with a folded corner: Documents.
  documents: (
    <>
      <path d="M6 3h8l4 4v14H6Z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </>
  ),
  // A clock turned back: what's been decided.
  decided: (
    <>
      <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8.3" />
      <path d="M3 3.5v4.8h4.8M12 7.5V12l3 2" />
    </>
  ),
  // Two linked rings: coalitions.
  coalitions: (
    <>
      <circle cx="9" cy="12" r="5.5" />
      <circle cx="15" cy="12" r="5.5" />
    </>
  ),
  // Two people: the group's people.
  people: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19.5c0-3.2 2.5-5.5 5.5-5.5s5.5 2.3 5.5 5.5" />
      <circle cx="16.5" cy="9.5" r="2.5" />
      <path d="M15.5 14.1c.3 0 .7-.1 1-.1 2.5 0 4.5 2 4.5 5" />
    </>
  ),
  // A shield: the Stewards.
  stewards: <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z" />,
  // A balance: the group's Rules.
  rules: (
    <>
      <path d="M12 4v16M8 20h8M5 7h14" />
      <path d="M5 7 2.5 13a2.5 2.5 0 0 0 5 0ZM19 7l-2.5 6a2.5 2.5 0 0 0 5 0Z" />
    </>
  ),
  // A door: Applications at the front door.
  applications: (
    <>
      <path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M4 21h16" />
      <circle cx="14.5" cy="12" r="0.75" />
    </>
  ),
  // A person and a plus: Invite people.
  invite: (
    <>
      <circle cx="10" cy="8.5" r="3.5" />
      <path d="M3.5 20c0-3.9 2.9-6.5 6.5-6.5 1.3 0 2.5.3 3.5.9M18 14v6M15 17h6" />
    </>
  ),
  // A speech bubble: the group's discussion.
  discussion: <path d="M4 5h16v10.5h-9L7 19v-3.5H4Z" />,
};

/** Props for {@link SectionGlyph}. */
export interface SectionGlyphProps {
  /** Which section it opens. */
  readonly kind: SectionGlyphKind;
}

/** A section's own 16px line glyph, decorative, set before its eyebrow. */
export function SectionGlyph({ kind }: SectionGlyphProps) {
  return (
    <svg
      className="section-glyph"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      {DRAWN[kind]}
    </svg>
  );
}
