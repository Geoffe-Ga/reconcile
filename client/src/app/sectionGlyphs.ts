/** The kinds of Group home section that open with a glyph (`SectionGlyph`, DESIGN.md "Section glyphs"). */

/** Every kind of section that has a glyph, in Group home's order. */
export const SECTION_GLYPHS = [
  'vote',
  'focus',
  'open',
  'dispatches',
  'documents',
  'decided',
  'coalitions',
  'people',
  'stewards',
  'rules',
  'applications',
  'invite',
  'discussion',
] as const;

/** A kind of section, which picks its glyph. */
export type SectionGlyphKind = (typeof SECTION_GLYPHS)[number];
