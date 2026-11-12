/**
 * Where a screen's Back link goes, and what it says (spec §8): to one of the
 * group's Documents (#92), by its title, or to Group home, by the group's name.
 */
import type { GroupState } from '../engine/fold';
import { documentNamed } from './documentLines';
import type { Route } from './router';

/** Where a Back link goes and what it says. */
export interface Back {
  readonly to: Route;
  readonly label: string;
}

/** Back to the group's Document `id`, by its title, or its first Document's when `id` names none (#92). */
export function documentBack(state: GroupState, id?: string): Back {
  const groupId = state.group ?? '';
  const document = documentNamed(state, id) ?? documentNamed(state);
  const to = document?.id;
  return {
    to: { name: 'document', groupId, ...(to === undefined ? {} : { documentId: to }) },
    label: document?.title ?? '',
  };
}

/** Back to Group home, by the group's name. */
export function groupBack(state: GroupState): Back {
  return { to: { name: 'group', groupId: state.group ?? '' }, label: state.name };
}
