/**
 * The app: hash routes to screens (spec §8), on the services `main.tsx` builds.
 *
 * Screens only show things and report what people did. This file turns those
 * reports into actions on the store and the relay, and moves between routes.
 */
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import type { GroupState } from '../engine/fold';
import { CreateGroup, type CreateOutcome } from '../screens/CreateGroup';
import { DocumentView } from '../screens/DocumentView';
import { GroupHome } from '../screens/GroupHome';
import { GroupMissing, GroupSettingUp } from '../screens/GroupStatus';
import { Join } from '../screens/Join';
import { Start } from '../screens/Start';
import type { Me } from '../store/db';
import {
  createGroup,
  type CreateGroupValues,
  type FoundGroup,
  joinGroup,
  lookupInvite,
} from './actions';
import { type Invite, inviteLink } from './invite';
import { navigate, replaceRoute, type Route, useRoute } from './router';
import type { AppServices } from './services';
import { GroupServicesContext, useGroup } from './useGroup';
import { useGroupList } from './useGroupList';

/** Props for {@link App}. */
export interface AppProps {
  /** The store, sync loop, relay and the rest, built once by `main.tsx`. */
  readonly services: AppServices;
}

interface StartScreenProps {
  readonly services: AppServices;
  readonly onOpenInvite: (invite: Invite) => void;
}

function StartScreen({ services, onOpenInvite }: StartScreenProps) {
  const groups = useGroupList(services.store);
  return groups === null ? null : <Start groups={groups} onOpenInvite={onOpenInvite} />;
}

function CreateScreen({ services }: { readonly services: AppServices }) {
  const onCreate = async (values: CreateGroupValues): Promise<CreateOutcome> => {
    const result = await createGroup(services, values);
    // Replace the form, so Back from the new group goes to Start, not to a second create.
    if (result.outcome === 'created') replaceRoute({ name: 'group', groupId: result.groupId });
    return result.outcome;
  };
  return <CreateGroup onCreate={onCreate} />;
}

interface JoinScreenProps {
  readonly services: AppServices;
  readonly payload: string | null;
  readonly heldInvite: Invite | null;
  readonly onJoined: () => void;
}

function JoinScreen({ services, payload, heldInvite, onJoined }: JoinScreenProps) {
  const lookup = useCallback((invite: Invite) => lookupInvite(services, invite), [services]);
  const onJoin = useCallback(
    async (invite: Invite, group: FoundGroup, name: string) => {
      const groupId = await joinGroup(services, invite, group, name);
      onJoined();
      replaceRoute({ name: 'group', groupId });
      return true;
    },
    [services, onJoined],
  );
  return <Join payload={payload} heldInvite={heldInvite} lookup={lookup} onJoin={onJoin} />;
}

/** A group on this device whose genesis is back from the relay. */
interface ReadyGroup {
  readonly state: GroupState;
  readonly me: Me;
  readonly invite: Invite;
}

interface GroupGateProps {
  readonly groupId: string;
  readonly children: (group: ReadyGroup) => ReactNode;
}

/** Renders `children` once the group is ready, or says why it isn't. */
function GroupGate({ groupId, children }: GroupGateProps) {
  const { loaded, state, me, invite } = useGroup(groupId);
  if (!loaded) return null;
  if (state === null || me === null || invite === null) return <GroupMissing />;
  if (state.group === null) return <GroupSettingUp />;
  return children({ state, me, invite });
}

interface GroupScreenProps {
  readonly services: AppServices;
  readonly groupId: string;
}

function GroupScreen({ services, groupId }: GroupScreenProps) {
  return (
    <GroupGate groupId={groupId}>
      {({ state, me, invite }) => (
        <GroupHome
          state={state}
          me={me.author}
          inviteLink={inviteLink(services.origin, invite)}
          copyText={services.copyText}
        />
      )}
    </GroupGate>
  );
}

function DocumentScreen({ groupId }: { readonly groupId: string }) {
  return <GroupGate groupId={groupId}>{({ state }) => <DocumentView state={state} />}</GroupGate>;
}

interface ScreenProps {
  readonly route: Route;
  readonly services: AppServices;
  readonly heldInvite: Invite | null;
  readonly holdInvite: (invite: Invite | null) => void;
}

function Screen({ route, services, heldInvite, holdInvite }: ScreenProps) {
  const releaseInvite = useCallback(() => {
    holdInvite(null);
  }, [holdInvite]);
  const openInvite = useCallback(
    (invite: Invite) => {
      holdInvite(invite);
      navigate({ name: 'join', payload: null });
    },
    [holdInvite],
  );
  switch (route.name) {
    case 'start':
      return <StartScreen services={services} onOpenInvite={openInvite} />;
    case 'create':
      return <CreateScreen services={services} />;
    case 'join':
      return (
        <JoinScreen
          services={services}
          payload={route.payload}
          heldInvite={heldInvite}
          onJoined={releaseInvite}
        />
      );
    case 'group':
      return <GroupScreen services={services} groupId={route.groupId} />;
    case 'document':
      return <DocumentScreen groupId={route.groupId} />;
  }
}

/** The current route's screen, with the store and sync loop provided to `useGroup`. */
export function App({ services }: AppProps) {
  const route = useRoute();
  // A pasted invite travels here, in memory, rather than through the address bar.
  const [heldInvite, holdInvite] = useState<Invite | null>(null);
  const groupServices = useMemo(
    () => ({ store: services.store, sync: services.sync }),
    [services.store, services.sync],
  );
  return (
    <GroupServicesContext value={groupServices}>
      <Screen route={route} services={services} heldInvite={heldInvite} holdInvite={holdInvite} />
    </GroupServicesContext>
  );
}
