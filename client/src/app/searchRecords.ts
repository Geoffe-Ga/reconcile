/**
 * What search reads (#445): the records this device's folded groups and
 * coalitions, its personal Documents and the app's own places give it, built
 * in memory each time they change and never kept.
 *
 * A group gives its name, its Documents by title, each section by its text,
 * its Proposals by title and justification, and its Dispatches by title and
 * text; an archived group, its Documents only. A coalition gives its name
 * and its Documents. Never searched: ballots, their reasons and notes (they
 * expire, ADR-0072, and search mustn't become a way to find how someone
 * voted), applications, room messages, and people's names (ADR-0009).
 */
import type { PersonalEntry } from '../store/personal';
import type { GroupState } from '../engine/fold';
import { messages } from './messages';
import type { Route } from './router';
import type { SearchRecord } from './search';

/** A group this device holds, folded. */
export interface HeldGroupView {
  readonly groupId: string;
  readonly state: GroupState;
  /** True once it's a read-only archive (#108): only its Documents are searched. */
  readonly archived: boolean;
}

/** A coalition this device holds, folded. */
export interface HeldCoalitionView {
  readonly coalitionId: string;
  readonly state: GroupState;
}

/** Everything search reads. */
export interface Holdings {
  readonly groups: readonly HeldGroupView[];
  readonly coalitions: readonly HeldCoalitionView[];
  readonly personal: readonly Pick<PersonalEntry, 'id' | 'title' | 'text' | 'updatedAt'>[];
}

/** The app's own places, by name. */
const PLACES: readonly [keyof typeof messages.search.places, Route][] = [
  ['start', { name: 'start' }],
  ['discover', { name: 'discover' }],
  ['personal', { name: 'personal' }],
  ['settings', { name: 'settings' }],
  ['recovery', { name: 'recovery' }],
  ['create', { name: 'create' }],
];

/** Where a Document of `owner` opens: a group's Document view, or a coalition's. */
type DocumentRoute = (documentId: string) => Route;

/** `state`'s Documents by title, and each section by its text, from `from`. */
function documentRecords(
  key: string,
  state: GroupState,
  from: string,
  open: DocumentRoute,
): SearchRecord[] {
  const titles = new Map(state.documents.map((document) => [document.id, document.title]));
  const documents = state.documents.map((document): SearchRecord => ({
    kind: 'document',
    id: `document:${key}:${document.id}`,
    title: document.title,
    text: '',
    from,
    at: state.at,
    route: open(document.id),
  }));
  const sections = state.atoms.map((atom): SearchRecord => ({
    kind: 'section',
    id: `section:${key}:${atom.id}`,
    title: titles.get(atom.documentId) ?? '',
    text: atom.text,
    from,
    at: state.at,
    route: open(atom.documentId),
    section: atom.id,
  }));
  return [...documents, ...sections];
}

/** A live group's Proposals by title and justification, and its Dispatches by title and text. */
function activityRecords(groupId: string, state: GroupState): SearchRecord[] {
  const proposals = state.proposals.map((proposal): SearchRecord => ({
    kind: 'proposal',
    id: `proposal:${groupId}:${proposal.id}`,
    title: proposal.title,
    text: proposal.why,
    from: state.name,
    at: proposal.received,
    route: { name: 'proposal', groupId, proposalId: proposal.id },
  }));
  const dispatches = state.dispatches.map((dispatch): SearchRecord => ({
    kind: 'dispatch',
    id: `dispatch:${groupId}:${dispatch.id}`,
    title: dispatch.title,
    text: dispatch.text,
    from: state.name,
    at: dispatch.received,
    route: { name: 'dispatches', groupId },
  }));
  return [...proposals, ...dispatches];
}

/** What a group gives search: everything for a live one, its Documents for an archive. */
function groupRecords({ groupId, state, archived }: HeldGroupView): SearchRecord[] {
  if (state.group === null) return [];
  const documents = documentRecords(groupId, state, state.name, (documentId) => ({
    name: 'document',
    groupId,
    documentId,
  }));
  if (archived) return documents;
  const group: SearchRecord = {
    kind: 'group',
    id: `group:${groupId}`,
    title: state.name,
    text: '',
    from: '',
    at: state.at,
    route: { name: 'group', groupId },
  };
  return [group, ...documents, ...activityRecords(groupId, state)];
}

/** What a coalition gives search: its name, and its Documents. */
function coalitionRecords({ coalitionId, state }: HeldCoalitionView): SearchRecord[] {
  if (state.group === null) return [];
  const coalition: SearchRecord = {
    kind: 'coalition',
    id: `coalition:${coalitionId}`,
    title: state.name,
    text: '',
    from: '',
    at: state.at,
    route: { name: 'coalition', coalitionId },
  };
  const documents = documentRecords(coalitionId, state, state.name, (documentId) => ({
    name: 'coalitionDocument',
    coalitionId,
    documentId,
  }));
  return [coalition, ...documents];
}

/** Every record this device's holdings give search, with the app's own places. */
export function recordsOf(holdings: Holdings): SearchRecord[] {
  const personal = holdings.personal.map((entry): SearchRecord => ({
    kind: 'personal',
    id: `personal:${entry.id}`,
    title: entry.title,
    text: entry.text,
    from: '',
    at: entry.updatedAt,
    route: { name: 'personalDocument', id: entry.id },
  }));
  const places = PLACES.map(([key, route]): SearchRecord => ({
    kind: 'place',
    id: `place:${key}`,
    title: messages.search.places[key],
    text: '',
    from: '',
    at: 0,
    route,
  }));
  return [
    ...holdings.groups.flatMap(groupRecords),
    ...holdings.coalitions.flatMap(coalitionRecords),
    ...personal,
    ...places,
  ];
}
