/**
 * What the screens say about a group's Documents (#92; spec §8), apart from
 * any component: the Document a Proposal changes or creates, which leads its
 * card, ballot and result, and a section's number in its own Document.
 */
import { atomsOf, documentOf, type GroupDocument, type ProposedChange } from '../engine/documents';
import type { Atom, GroupState } from '../engine/fold';

/**
 * What leads a Proposal (#92): the Document it changes, by title, or, for a
 * new Document's Proposal, the title it would have and whether its pass has
 * made it one of the group's Documents yet.
 */
export type DocumentLead =
  | { readonly kind: 'document'; readonly id: string; readonly title: string }
  | { readonly kind: 'new'; readonly id: string; readonly title: string; readonly exists: boolean };

/**
 * The Document a Proposal changes or creates, as it leads the Proposal's card,
 * ballot and result: none for a Proposal that changes no Document, such as a
 * steward, rules or dissolve one.
 */
export function documentLead(state: GroupState, proposal: ProposedChange): DocumentLead | null {
  const id = documentOf(state, proposal);
  if (id === null) return null;
  const { target } = proposal;
  const known = state.documents.find((document) => document.id === id);
  if (target.kind === 'new-document') {
    return { kind: 'new', id, title: target.title, exists: known !== undefined };
  }
  return known === undefined ? null : { kind: 'document', id, title: known.title };
}

/** A section with its place in its own Document, numbered from 1, and that Document. */
export interface SectionPlace {
  readonly atom: Atom;
  readonly number: number;
  readonly document: GroupDocument;
}

/** Where the section `atomId` is: its Document, and its number there; null when it isn't in one. */
export function sectionPlace(state: GroupState, atomId: string): SectionPlace | null {
  const atom = state.atoms.find((candidate) => candidate.id === atomId);
  const document = state.documents.find((candidate) => candidate.id === atom?.documentId);
  if (atom === undefined || document === undefined) return null;
  const number = atomsOf(state, document.id).findIndex((candidate) => candidate.id === atomId) + 1;
  return { atom, number, document };
}

/** The Document `id` names, or the group's first when it names none; undefined when there's no such Document. */
export function documentNamed(state: GroupState, id?: string): GroupDocument | undefined {
  return id === undefined ? state.documents[0] : state.documents.find((d) => d.id === id);
}
