/**
 * The app: hash routes to screens (spec §8), on the services `main.tsx` builds.
 *
 * Screens only show things and report what people did. This file turns those
 * reports into actions on the store and the relay, and moves between routes.
 */
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import type { Level } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { ownBallot } from '../engine/ownBallot';
import { isPriority } from '../engine/priority';
import { Composer, type ComposeOutcome } from '../screens/Composer';
import { CreateGroup, type CreateOutcome } from '../screens/CreateGroup';
import { DocumentView } from '../screens/DocumentView';
import { GroupHome } from '../screens/GroupHome';
import { GroupMissing, GroupSettingUp } from '../screens/GroupStatus';
import { Join } from '../screens/Join';
import { PriorityComposer } from '../screens/PriorityComposer';
import { ProposalView } from '../screens/ProposalView';
import { Start } from '../screens/Start';
import type { Persistence } from '../platform/persist';
import type { Me } from '../store/db';
import { groupDrafts } from '../store/drafts';
import {
  createGroup,
  type CreateGroupValues,
  type FoundGroup,
  joinGroup,
  lookupInvite,
} from './actions';
import { type Invite, inviteLink } from './invite';
import type { Scores } from './Ballot';
import {
  addVersion,
  askPriority,
  castBallot,
  chooseLevel,
  type PriorityValues,
  propose,
  type ProposalValues,
  type VersionValues,
} from './proposals';
import { navigate, replaceRoute, type Route, useRoute } from './router';
import type { AppServices } from './services';
import { relayMinuteNow } from './time';
import { GroupServicesContext, type GroupView, useGroup } from './useGroup';
import { useGroupList } from './useGroupList';
import { useNow } from './useNow';

/** Props for {@link App}. */
export interface AppProps {
  /** The store, sync loop, relay and the rest, built once by `main.tsx`. */
  readonly services: AppServices;
  /** An invite link first run took out of the address bar, which Join opens. */
  readonly initialInvite?: Invite | null;
  /** What the browser said about keeping this site's data, for Start. */
  readonly persistence?: Persistence | null;
}

interface StartScreenProps {
  readonly services: AppServices;
  readonly onOpenInvite: (invite: Invite) => void;
  readonly persistence: Persistence | null;
}

function StartScreen({ services, onOpenInvite, persistence }: StartScreenProps) {
  const groups = useGroupList(services.store);
  return groups === null ? null : (
    <Start groups={groups} onOpenInvite={onOpenInvite} persistence={persistence} />
  );
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
    async (invite: Invite, group: FoundGroup, name: string, level: Level) => {
      const groupId = await joinGroup(services, invite, group, name, level);
      onJoined();
      replaceRoute({ name: 'group', groupId });
      return true;
    },
    [services, onJoined],
  );
  return <Join payload={payload} heldInvite={heldInvite} lookup={lookup} onJoin={onJoin} />;
}

/** A group on this device whose genesis is back from the relay. */
interface ReadyGroup extends GroupView {
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
  const group = useGroup(groupId);
  const { loaded, state, me, invite } = group;
  if (!loaded) return null;
  if (state === null || me === null || invite === null) return <GroupMissing />;
  if (state.group === null) return <GroupSettingUp />;
  return children({ ...group, state, me, invite });
}

interface GroupScreenProps {
  readonly services: AppServices;
  readonly groupId: string;
}

function GroupScreen({ services, groupId }: GroupScreenProps) {
  const deviceNow = useNow(services.now);
  return (
    <GroupGate groupId={groupId}>
      {(group) => (
        <GroupHome
          state={group.state}
          me={group.me.author}
          inviteLink={inviteLink(services.origin, group.invite)}
          copyText={services.copyText}
          now={relayMinuteNow(group, deviceNow)}
          sync={{ reachable: group.reachable, lastSyncAt: group.lastSyncAt, deviceNow }}
          pending={group.pending}
          onChooseLevel={(level) => chooseLevel(services, groupId, level)}
        />
      )}
    </GroupGate>
  );
}

function DocumentScreen({ groupId }: { readonly groupId: string }) {
  const openComposer = (atomId: string) => {
    navigate({ name: 'propose', groupId, atomId });
  };
  return (
    <GroupGate groupId={groupId}>
      {({ state, me }) => <DocumentView state={state} me={me.author} onPropose={openComposer} />}
    </GroupGate>
  );
}

/** Queues a priority vote, then shows it in place of the composer (#107). */
function askFor(services: AppServices, groupId: string) {
  return async (values: PriorityValues): Promise<ComposeOutcome> => {
    const result = await askPriority(services, groupId, values);
    if (result.outcome === 'too-large') return result.outcome;
    // Replace the composer, so Back from the vote returns to Group home.
    replaceRoute({ name: 'proposal', groupId, proposalId: result.proposalId });
    return result.outcome;
  };
}

/** Ask what to focus on (`priority`, #107). */
function PriorityScreen({ services, groupId }: GroupScreenProps) {
  return (
    <GroupGate groupId={groupId}>
      {({ state, me }) => (
        <PriorityComposer state={state} me={me.author} onAsk={askFor(services, groupId)} />
      )}
    </GroupGate>
  );
}

interface ProposeScreenProps extends GroupScreenProps {
  /** The section to propose on, from `propose/{atomId}`. */
  readonly atomId?: string;
  /** The lapsed Proposal to propose again, from `again/{proposalId}` (#74). */
  readonly againId?: string;
}

function ProposeScreen({ services, groupId, atomId, againId }: ProposeScreenProps) {
  // One stable handle per group, so the composer reads its draft once, not on every sync.
  const drafts = useMemo(() => groupDrafts(services.store, groupId), [services.store, groupId]);
  return (
    <GroupGate groupId={groupId}>
      {({ state, me }) => {
        const again = state.proposals.find((proposal) => proposal.id === againId);
        if (again !== undefined && isPriority(again)) {
          return (
            <PriorityComposer
              state={state}
              me={me.author}
              onAsk={askFor(services, groupId)}
              again={again}
            />
          );
        }
        const onPropose = async (values: ProposalValues): Promise<ComposeOutcome> => {
          const result = await propose(services, groupId, values);
          if (result.outcome === 'too-large') return result.outcome;
          // Replace the composer, so Back from the Proposal returns to the Document.
          replaceRoute({ name: 'proposal', groupId, proposalId: result.proposalId });
          return result.outcome;
        };
        const onAddVersion = async (values: VersionValues): Promise<ComposeOutcome> => {
          const result = await addVersion(services, groupId, values);
          if (result.outcome === 'too-large') return result.outcome;
          // Replace the composer with the Proposal the version joins.
          replaceRoute({ name: 'proposal', groupId, proposalId: values.proposal });
          return result.outcome;
        };
        return (
          <Composer
            state={state}
            me={me.author}
            atomId={again?.atom ?? atomId ?? ''}
            drafts={drafts}
            onPropose={onPropose}
            onAddVersion={onAddVersion}
            {...(again === undefined ? {} : { again })}
          />
        );
      }}
    </GroupGate>
  );
}

interface ProposalScreenProps extends GroupScreenProps {
  readonly proposalId: string;
}

function ProposalScreen({ services, groupId, proposalId }: ProposalScreenProps) {
  const deviceNow = useNow(services.now);
  return (
    <GroupGate groupId={groupId}>
      {(group) => {
        const author = group.me.author;
        const onVote = (scores: Scores, note: string) =>
          castBallot(services, groupId, { proposal: proposalId, scores, note });
        const onProposeAgain = () => {
          navigate({ name: 'again', groupId, proposalId });
        };
        return (
          <ProposalView
            state={group.state}
            me={author}
            proposalId={proposalId}
            pending={group.pending}
            reachable={group.reachable}
            now={relayMinuteNow(group, deviceNow)}
            own={ownBallot(group.state, group.log, proposalId, author)}
            onVote={onVote}
            onProposeAgain={onProposeAgain}
          />
        );
      }}
    </GroupGate>
  );
}

interface ScreenProps {
  readonly route: Route;
  readonly services: AppServices;
  readonly heldInvite: Invite | null;
  readonly holdInvite: (invite: Invite | null) => void;
  readonly persistence: Persistence | null;
}

function Screen({ route, services, heldInvite, holdInvite, persistence }: ScreenProps) {
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
      return (
        <StartScreen services={services} onOpenInvite={openInvite} persistence={persistence} />
      );
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
    case 'propose':
      return <ProposeScreen services={services} groupId={route.groupId} atomId={route.atomId} />;
    case 'priority':
      return <PriorityScreen services={services} groupId={route.groupId} />;
    case 'proposal':
      return (
        <ProposalScreen services={services} groupId={route.groupId} proposalId={route.proposalId} />
      );
    case 'again':
      return (
        <ProposeScreen services={services} groupId={route.groupId} againId={route.proposalId} />
      );
  }
}

/** The current route's screen, with the store and sync loop provided to `useGroup`. */
export function App({ services, initialInvite = null, persistence = null }: AppProps) {
  const route = useRoute();
  // A pasted invite, or one first run held, travels here in memory rather than in the address bar.
  const [heldInvite, holdInvite] = useState<Invite | null>(initialInvite);
  const groupServices = useMemo(
    () => ({ store: services.store, sync: services.sync }),
    [services.store, services.sync],
  );
  return (
    <GroupServicesContext value={groupServices}>
      <Screen
        route={route}
        services={services}
        heldInvite={heldInvite}
        holdInvite={holdInvite}
        persistence={persistence}
      />
    </GroupServicesContext>
  );
}
