/**
 * A group's Documents (#92; docs/spec/phase-1-spec.md §4; ADR-0074): what a
 * Document's title may be, how a new Document's text becomes its first
 * sections, and which Document a Proposal changes.
 *
 * A group founds one or more Documents at genesis, and adds more by Proposal.
 * Every Atom keeps its Document's id (ADR-0073's seam): the genesis id for
 * the first Document, `${genesisId}:${k}` for founding Document k ≥ 1, and a
 * new Document's own Proposal id. Atom ids follow from those: `${documentId}.${i}`
 * for the sections a Document starts with, and an add's own Proposal id for a
 * section added later (#75). The fold and the screens ask the same functions
 * here, so a screen never offers what the fold would refuse. This file
 * imports nothing from the fold: it reads only the few fields it names.
 */
import type { ProposalTarget } from './stewards';
import { codePointLength, splitAtoms } from './text';

/** The longest Document title, in code points. */
export const DOCUMENT_TITLE_MAX = 120;

/** One of a group's Documents (#92): its id and its title, which no Proposal changes yet. */
export interface GroupDocument {
  readonly id: string;
  readonly title: string;
}

/** What the Document rules read of a section: its id and its Document's. */
export interface SectionRef {
  readonly id: string;
  readonly documentId: string;
}

/** What {@link documentOf} reads of a Proposal: its id, its Atom and its target. */
export interface ProposedChange {
  readonly id: string;
  readonly atom: string;
  readonly target: ProposalTarget;
}

/** What the Document rules read of a group: its Documents in order, their sections, and its Proposals. */
export interface DocumentsState {
  readonly documents: readonly GroupDocument[];
  readonly atoms: readonly SectionRef[];
  readonly proposals: readonly ProposedChange[];
}

/**
 * True when `title` may name a Document: not blank, and at most 120 code
 * points as received. The fold never re-normalizes, so it counts code points
 * as they arrive; an author's title is NFC already (spec §3).
 */
export function documentTitleFits(title: string): boolean {
  return title.trim() !== '' && codePointLength(title) <= DOCUMENT_TITLE_MAX;
}

/**
 * A new Document's first sections, from its text: split at blank lines
 * (`splitAtoms`), each ending in one newline, as a normalized Atom does. Blank
 * text gives none, so no Document starts empty.
 */
export function documentSections(text: string): string[] {
  return splitAtoms(text).map((section) => `${section}\n`);
}

/**
 * The Document a section belongs to, even once a removal has taken it out:
 * the one it's in now, else the one its add put it in, else the one its id
 * names (`${documentId}.${i}`), or null when nothing says.
 */
function documentOfSection(state: DocumentsState, atom: string): string | null {
  const live = state.atoms.find((candidate) => candidate.id === atom);
  if (live !== undefined) return live.documentId;
  const added = state.proposals.find((p) => p.id === atom && p.target.kind === 'add')?.target;
  if (added?.kind === 'add') return added.document;
  const dot = atom.lastIndexOf('.');
  return dot === -1 ? null : atom.slice(0, dot);
}

/**
 * The Document a Proposal changes (#92): its section's for a change or a
 * removal, the one an add names (#75), or, for a new Document, the Document
 * it creates, whose id is its own. Null for a Proposal that changes no
 * Document, such as a steward, rules or dissolve one.
 */
export function documentOf(state: DocumentsState, proposal: ProposedChange): string | null {
  const { target } = proposal;
  switch (target.kind) {
    case 'edit':
      return documentOfSection(state, proposal.atom);
    case 'add':
      return target.document;
    case 'new-document':
      return proposal.id;
    default:
      return null;
  }
}

/** One Document's sections, in order. */
export function atomsOf<A extends SectionRef>(
  state: { readonly atoms: readonly A[] },
  documentId: string,
): A[] {
  return state.atoms.filter((atom) => atom.documentId === documentId);
}

/** The title of the group's Document `id`, or null for none or one it doesn't have. */
export function documentTitle(
  state: { readonly documents: readonly GroupDocument[] },
  id: string | null,
): string | null {
  return state.documents.find((document) => document.id === id)?.title ?? null;
}
