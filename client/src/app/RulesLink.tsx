import { Link } from 'react-aria-components';

import type { GroupState } from '../engine/fold';
import { messages } from './messages';
import { optInState } from './optInLines';
import { routeHref } from './router';

/**
 * Group home's link to the group's rules (#117): "Chat bot and front door",
 * with where each stands now, "Chat bot: Off · Front door: Closed". A steward's
 * narrowing reads as off, and a door a membership's end closed reads "Closed
 * when a member left" until a door opens again (#288).
 */
export function RulesLink({ state }: { readonly state: GroupState }) {
  const { optIns, app } = messages;
  const door =
    state.doorClosure === null ? optInState(state, 'frontDoor').label : optIns.closedByLeave;
  const summary = optIns.homeSummary(optInState(state, 'chatBot').label, door);
  return (
    <Link className="card-link" href={routeHref({ name: 'rules', groupId: state.group ?? '' })}>
      <span className="card-link-title">
        <span className="heading-3">{optIns.homeLink}</span>
        <span className="card-link-arrow" aria-hidden="true">
          {app.forward}
        </span>
      </span>
      <span className="meta">{summary}</span>
    </Link>
  );
}
