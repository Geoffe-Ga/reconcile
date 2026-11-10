/**
 * The app: hash routes to screens (spec §8), on the services `main.tsx` builds.
 *
 * Screens only show things and report what people did. This file turns those
 * reports into actions on the store and the relay, and moves between routes.
 */
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import type { Level } from '../engine/capabilities';
import { fold, type GroupState } from '../engine/fold';
import { ownBallot } from '../engine/ownBallot';
import { Composer, type ComposeOutcome } from '../screens/Composer';
import { CreateGroup, type CreateOutcome } from '../screens/CreateGroup';
import { DissolveComposer } from '../screens/DissolveComposer';
import { DocumentView } from '../screens/DocumentView';
import { GroupHome } from '../screens/GroupHome';
import { GroupRules } from '../screens/GroupRules';
import { GroupArchived, GroupMissing, GroupSettingUp } from '../screens/GroupStatus';
import { Join } from '../screens/Join';
import { LinkNewDevice } from '../screens/LinkNewDevice';
import { LinkThisDevice } from '../screens/LinkThisDevice';
import type { OptIn } from '../engine/optIns';
import { OptInComposer, type OptInOutcome } from '../screens/OptInComposer';
import { Personal } from '../screens/Personal';
import { PersonalDocument } from '../screens/PersonalDocument';
import { ProposalView } from '../screens/ProposalView';
import { type NotifyGroup, Settings } from '../screens/Settings';
import { SharedPage } from '../screens/SharedPage';
import type { SeatNumber } from '../engine/stewards';
import type { GuideRecord } from '../platform/guide';
import type { Persistence } from '../platform/persist';
import { Start } from '../screens/Start';
import { StewardComposer, type StewardOutcome } from '../screens/StewardComposer';
import type { Group, Me } from '../store/db';
import { groupDrafts } from '../store/drafts';
import type { LinkCode } from '../crypto/link';
import { joinLink, offerLink } from '../link/session';
import { newPersonalId } from '../store/personal';
import {
  createGroup,
  type CreateGroupValues,
  type FoundGroup,
  joinGroup,
  leaveGroup,
  lookupInvite,
  makeInvite,
} from './actions';
import { makeBackup, restoreBackup, saveBackup } from './backup';
import { personalSharing } from './personalSharing';
import { BackupCard } from './BackupCard';
import type { Scores } from './Ballot';
import { FirstRunGuide } from './FirstRunGuide';
import {
  addVersion,
  castBallot,
  chooseLevel,
  type DissolveValues,
  propose,
  proposeDissolve,
  proposeRules,
  proposeSteward,
  type RulesValues,
  type StewardValues,
  suspend,
  type ProposalValues,
  type VersionValues,
  vouch,
} from './proposals';
import { type GroupRoute, navigate, replaceRoute, type Route, useRoute } from './router';
import type { AppServices } from './services';
import type { ChatDetails, ChatMoment } from './chatMessages';
import { chatPayload, shareOrCopy } from './share';
import { relayMinuteNow } from './time';
import { GroupServicesContext, type GroupView, useGroup } from './useGroup';
import { useGroupList, useGroups } from './useGroupList';
import { useNow } from './useNow';
import { usePersonalList } from './usePersonalList';
import { useRelayBackupStatus } from './useRelayBackup';

/** Props for {@link App}. */
export interface AppProps {
  /** The store, sync loop, relay and the rest, built once by `main.tsx`. */
  readonly services: AppServices;
  /** The seed of an invite link first run took out of the address bar, which Join opens. */
  readonly initialSeed?: Uint8Array | null;
  /** What the browser said about keeping this site's data, for Start. */
  readonly persistence?: Persistence | null;
}

interface StartScreenProps {
  readonly services: AppServices;
  readonly onOpenInvite: (seed: Uint8Array) => void;
  readonly persistence: Persistence | null;
}

function StartScreen({ services, onOpenInvite, persistence }: StartScreenProps) {
  const groups = useGroupList(services.store);
  const onRestore = useCallback(
    (bytes: Uint8Array, passphrase: string) => restoreBackup(services, bytes, passphrase),
    [services],
  );
  return groups === null ? null : (
    <Start
      groups={groups}
      onOpenInvite={onOpenInvite}
      persistence={persistence}
      onRestore={onRestore}
    />
  );
}

/**
 * A group's push switch (#99): named once its genesis is back, and gone while
 * it's leaving or once it's a read-only archive (#108).
 */
function notifyGroupOf(group: Group): NotifyGroup | null {
  const state = fold(group.log, group.relayNow);
  // A read-only archive takes nothing new, push included (#108).
  if (state.group === null || group.leaving !== undefined || group.archived !== undefined) {
    return null;
  }
  return { groupId: group.groupId, name: state.name, on: group.push !== undefined };
}

/**
 * Settings (#78, #96, #99): Notifications, Save a backup with the relay
 * backup's line (#97), Restore a backup, Link a new device, and Erase.
 */
function SettingsScreen({ services }: { readonly services: AppServices }) {
  const groups = useGroupList(services.store);
  const switches = useGroups(services.store, notifyGroupOf);
  const relayBackup = useRelayBackupStatus(services.store);
  const { push } = services;
  return groups === null || switches === null || relayBackup === null ? null : (
    <Settings
      notify={{
        availability: push.availability(),
        groups: switches.filter((group) => group !== null),
        onTurnOn: (groupId) => push.turnOn(groupId),
        onTurnOff: (groupId) => push.turnOff(groupId),
      }}
      hasGroups={groups.length > 0}
      relayBackup={relayBackup}
      onMake={(passphrase) => makeBackup(services, passphrase)}
      onSave={(backup) => saveBackup(services, backup)}
      onRestore={(bytes, passphrase) => restoreBackup(services, bytes, passphrase)}
      onErase={services.erase}
    />
  );
}

/** Personal (#93): this device's personal Documents, and the id a new one opens at. */
function PersonalScreen({ services }: { readonly services: AppServices }) {
  const documents = usePersonalList(services.store);
  // One id per visit: nothing is stored under it until that Document's first save.
  const [newId] = useState(newPersonalId);
  return documents === null ? null : <Personal documents={documents} newId={newId} />;
}

interface PersonalDocumentScreenProps {
  readonly services: AppServices;
  readonly id: string;
}

/** One personal Document (#93), shareable by link (#105); deleting it goes back to Personal in its place. */
function PersonalDocumentScreen({ services, id }: PersonalDocumentScreenProps) {
  const onDeleted = useCallback(() => {
    replaceRoute({ name: 'personal' });
  }, []);
  const sharing = useMemo(() => personalSharing(services), [services]);
  return (
    <PersonalDocument
      id={id}
      documents={services.store}
      now={services.now}
      onDeleted={onDeleted}
      sharing={sharing}
    />
  );
}

/** Link a new device (#96), on the existing device: a fresh code each time it opens. */
function LinkNewScreen({ services }: { readonly services: AppServices }) {
  const start = useCallback(() => offerLink(services), [services]);
  return <LinkNewDevice start={start} copyText={services.copyText} />;
}

/** Link to my other device (#96), on the new device: syncs once the groups are in. */
function LinkThisScreen({ services }: { readonly services: AppServices }) {
  const join = useCallback((code: LinkCode) => joinLink(services, code), [services]);
  const onLinked = useCallback(() => {
    void services.sync.syncOnce();
  }, [services]);
  return <LinkThisDevice join={join} onLinked={onLinked} />;
}

interface CreateScreenProps {
  readonly services: AppServices;
  /** Offers the first-run guide on the new group's home (#91). */
  readonly offerGuide: (groupId: string) => void;
}

function CreateScreen({ services, offerGuide }: CreateScreenProps) {
  const onCreate = async (values: CreateGroupValues): Promise<CreateOutcome> => {
    const result = await createGroup(services, values);
    if (result.outcome === 'created') {
      offerGuide(result.groupId);
      // Replace the form, so Back from the new group goes to Start, not to a second create.
      replaceRoute({ name: 'group', groupId: result.groupId });
    }
    return result.outcome;
  };
  return <CreateGroup onCreate={onCreate} />;
}

interface JoinScreenProps {
  readonly services: AppServices;
  readonly payload: string | null;
  readonly heldSeed: Uint8Array | null;
  /** Lets go of the seed held in memory, once Join or Not now is done with it. */
  readonly releaseSeed: () => void;
  /** Offers the first-run guide on the joined group's home (#91). */
  readonly offerGuide: (groupId: string) => void;
}

function JoinScreen(props: JoinScreenProps) {
  const { services, payload, heldSeed, releaseSeed, offerGuide } = props;
  const lookup = useCallback((seed: Uint8Array) => lookupInvite(services, seed), [services]);
  const onJoin = useCallback(
    async (group: FoundGroup, name: string, level: Level) => {
      const groupId = await joinGroup(services, group, name, level);
      releaseSeed();
      offerGuide(groupId);
      replaceRoute({ name: 'group', groupId });
      return true;
    },
    [services, releaseSeed, offerGuide],
  );
  // Not now (#91): the held seed goes, and leaving Join drops the opened envelope with it.
  const onNotNow = useCallback(() => {
    releaseSeed();
    replaceRoute({ name: 'start' });
  }, [releaseSeed]);
  return (
    <Join
      payload={payload}
      heldSeed={heldSeed}
      lookup={lookup}
      onJoin={onJoin}
      onNotNow={onNotNow}
    />
  );
}

/** The first-run guide's offer (#91): the group a first create or join opened, until it closes. */
interface GuideOffer {
  /** The group whose home shows the guide, or null when none waits. */
  readonly groupId: string | null;
  /** Offers the guide on `groupId`'s home, unless this device has seen it. */
  readonly offer: (groupId: string) => void;
  /** Skip or Done: records the guide as seen on this device and closes it. */
  readonly close: () => void;
}

function useGuideOffer(guide: GuideRecord | undefined): GuideOffer {
  const [groupId, setGroupId] = useState<string | null>(null);
  const offer = useCallback(
    (id: string) => {
      if (guide !== undefined && !guide.seen()) setGroupId(id);
    },
    [guide],
  );
  const close = useCallback(() => {
    guide?.see();
    setGroupId(null);
  }, [guide]);
  return { groupId, offer, close };
}

interface GroupGuideProps {
  readonly route: GroupRoute;
  readonly guide: GuideOffer;
}

/** The guide over a group's home while it's offered there, or nothing on any other screen. */
function GroupGuide({ route, guide }: GroupGuideProps) {
  const home = route.name === 'group' && guide.groupId === route.groupId;
  return home ? <OfferedGuide groupId={route.groupId} onClose={guide.close} /> : null;
}

/** The offered guide, once the group's genesis and this member's join are back from the relay. */
function OfferedGuide({
  groupId,
  onClose,
}: {
  readonly groupId: string;
  readonly onClose: () => void;
}) {
  const { state, me } = useGroup(groupId);
  if (state === null || state.group === null || me === null) return null;
  return <FirstRunGuide state={state} me={me.author} onClose={onClose} />;
}

/** A group on this device whose genesis is back from the relay. */
interface ReadyGroup extends GroupView {
  readonly state: GroupState;
  readonly me: Me;
}

interface GroupGateProps {
  readonly groupId: string;
  /** True for a screen that writes something new: a dissolved group shows it only reads (#108). */
  readonly writes?: boolean;
  readonly children: (group: ReadyGroup) => ReactNode;
}

/** Renders `children` once the group is ready, or says why it isn't. */
function GroupGate({ groupId, writes = false, children }: GroupGateProps) {
  const group = useGroup(groupId);
  const { loaded, state, me } = group;
  if (!loaded) return null;
  if (state === null || me === null) return <GroupMissing />;
  if (state.group === null) return <GroupSettingUp />;
  if (writes && state.dissolved !== null)
    return <GroupArchived groupId={groupId} name={state.name} />;
  return children({ ...group, state, me });
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
          makeInviteLink={() => makeInvite(services, groupId, services.origin)}
          copyText={services.copyText}
          now={relayMinuteNow(group, deviceNow)}
          sync={{
            reachable: group.reachable,
            lastSyncAt: group.lastSyncAt,
            deviceNow,
            missingHistory: group.missingHistory,
            keyChange: group.keyChange,
          }}
          pending={group.pending}
          leaving={group.leaving}
          backupCard={
            group.suggestBackup && !group.leaving ? (
              <BackupCard onNotNow={() => services.store.markBackup([groupId], 'not-now')} />
            ) : null
          }
          onChooseLevel={(level) => chooseLevel(services, groupId, level)}
          onLeave={async () => {
            await leaveGroup(services, groupId);
            // Back to Your groups, where the group reads Leaving… until the relay has the leave.
            replaceRoute({ name: 'start' });
          }}
          onSuspend={(member, reason) => suspend(services, groupId, { member, reason })}
          onVouch={(member) => vouch(services, groupId, member)}
          onRemove={async () => {
            await services.store.purgeGroup(groupId);
            replaceRoute({ name: 'start' });
          }}
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
      {({ state, me, leaving }) => (
        <DocumentView state={state} me={me.author} onPropose={openComposer} leaving={leaving} />
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
  const deviceNow = useNow(services.now);
  return (
    <GroupGate groupId={groupId} writes>
      {({ state, me, leaving }) => {
        const again = state.proposals.find((proposal) => proposal.id === againId);
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
            now={deviceNow}
            onPropose={onPropose}
            onAddVersion={onAddVersion}
            leaving={leaving}
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
        const onTell = (moment: ChatMoment, details: ChatDetails) =>
          shareOrCopy(chatPayload(moment, details, services.origin), services);
        return (
          <ProposalView
            state={group.state}
            me={author}
            proposalId={proposalId}
            pending={group.pending}
            reachable={group.reachable}
            now={relayMinuteNow(group, deviceNow)}
            own={ownBallot(group.state, group.log, proposalId, author)}
            leaving={group.leaving}
            {...(group.cleared === null ? {} : { cleared: group.cleared })}
            onVote={onVote}
            onProposeAgain={onProposeAgain}
            onTell={onTell}
          />
        );
      }}
    </GroupGate>
  );
}

interface StewardScreenProps extends GroupScreenProps {
  readonly seat: SeatNumber;
  readonly recall: boolean;
}

/** The steward composer (#102); sending a Proposal replaces it with the Proposal's ballot. */
function StewardScreen({ services, groupId, seat, recall }: StewardScreenProps) {
  const onPropose = async (values: StewardValues): Promise<StewardOutcome> => {
    const result = await proposeSteward(services, groupId, values);
    if (result.outcome === 'too-large') return result.outcome;
    // Replace the composer, so Back from the Proposal returns to Group home.
    replaceRoute({ name: 'proposal', groupId, proposalId: result.proposalId });
    return result.outcome;
  };
  return (
    <GroupGate groupId={groupId} writes>
      {({ state, me }) => (
        <StewardComposer
          state={state}
          me={me.author}
          seat={seat}
          recall={recall}
          onPropose={onPropose}
        />
      )}
    </GroupGate>
  );
}

function RulesScreen({ groupId }: { readonly groupId: string }) {
  return (
    <GroupGate groupId={groupId} writes>
      {({ state, me }) => <GroupRules state={state} me={me.author} />}
    </GroupGate>
  );
}

interface OptInScreenProps extends GroupScreenProps {
  readonly optIn: OptIn;
  readonly narrow: boolean;
}

/** The opt-in composer (#117); sending a Proposal replaces it with the Proposal's ballot. */
function OptInScreen({ services, groupId, optIn, narrow }: OptInScreenProps) {
  const deviceNow = useNow(services.now);
  const onPropose = async (values: RulesValues): Promise<OptInOutcome> => {
    const result = await proposeRules(services, groupId, values);
    if (result.outcome === 'too-large') return result.outcome;
    // Replace the composer, so Back from the Proposal returns to the rules.
    replaceRoute({ name: 'proposal', groupId, proposalId: result.proposalId });
    return result.outcome;
  };
  return (
    <GroupGate groupId={groupId} writes>
      {({ state, me }) => (
        <OptInComposer
          state={state}
          me={me.author}
          optIn={optIn}
          narrow={narrow}
          now={deviceNow}
          onPropose={onPropose}
        />
      )}
    </GroupGate>
  );
}

/** The dissolve composer (#108); sending the Proposal replaces it with the Proposal's ballot. */
function DissolveScreen({ services, groupId }: GroupScreenProps) {
  const deviceNow = useNow(services.now);
  const onPropose = async (values: DissolveValues) => {
    const result = await proposeDissolve(services, groupId, values);
    if (result.outcome === 'too-large') return result.outcome;
    // Replace the composer, so Back from the Proposal returns to Group home.
    replaceRoute({ name: 'proposal', groupId, proposalId: result.proposalId });
    return result.outcome;
  };
  return (
    <GroupGate groupId={groupId} writes>
      {({ state, me, leaving }) => (
        <DissolveComposer
          state={state}
          me={me.author}
          now={deviceNow}
          leaving={leaving}
          onPropose={onPropose}
        />
      )}
    </GroupGate>
  );
}

/** A route inside one group. */

/** The screen for a route inside one group. */
function GroupRouteScreen({ route, services }: { route: GroupRoute; services: AppServices }) {
  const { groupId } = route;
  switch (route.name) {
    case 'group':
      return <GroupScreen services={services} groupId={groupId} />;
    case 'document':
      return <DocumentScreen groupId={groupId} />;
    case 'propose':
      return <ProposeScreen services={services} groupId={groupId} atomId={route.atomId} />;
    case 'proposal':
      return <ProposalScreen services={services} groupId={groupId} proposalId={route.proposalId} />;
    case 'again':
      return <ProposeScreen services={services} groupId={groupId} againId={route.proposalId} />;
    case 'steward':
      return (
        <StewardScreen
          services={services}
          groupId={groupId}
          seat={route.seat}
          recall={route.recall}
        />
      );
    case 'rules':
      return <RulesScreen groupId={groupId} />;
    case 'optIn':
      return (
        <OptInScreen
          services={services}
          groupId={groupId}
          optIn={route.optIn}
          narrow={route.narrow}
        />
      );
    case 'dissolve':
      return <DissolveScreen services={services} groupId={groupId} />;
  }
}

interface ScreenProps {
  readonly route: Route;
  readonly services: AppServices;
  readonly heldSeed: Uint8Array | null;
  readonly holdSeed: (seed: Uint8Array | null) => void;
  readonly persistence: Persistence | null;
  readonly guide: GuideOffer;
}

function Screen({ route, services, heldSeed, holdSeed, persistence, guide }: ScreenProps) {
  const releaseSeed = useCallback(() => {
    holdSeed(null);
  }, [holdSeed]);
  const openInvite = useCallback(
    (seed: Uint8Array) => {
      holdSeed(seed);
      navigate({ name: 'join', payload: null });
    },
    [holdSeed],
  );
  switch (route.name) {
    case 'start':
      return (
        <StartScreen services={services} onOpenInvite={openInvite} persistence={persistence} />
      );
    case 'create':
      return <CreateScreen services={services} offerGuide={guide.offer} />;
    case 'settings':
      return <SettingsScreen services={services} />;
    case 'personal':
      return <PersonalScreen services={services} />;
    case 'personalDocument':
      // Keyed by id, so another Document starts its editor afresh.
      return <PersonalDocumentScreen key={route.id} services={services} id={route.id} />;
    case 'shared':
      // Root shows a share link's page before first run; App shows it too, on the same relay.
      return <SharedPage payload={route.payload} reader={services} />;
    case 'linkNew':
      return <LinkNewScreen services={services} />;
    case 'linkThis':
      return <LinkThisScreen services={services} />;
    case 'join':
      return (
        <JoinScreen
          services={services}
          payload={route.payload}
          heldSeed={heldSeed}
          releaseSeed={releaseSeed}
          offerGuide={guide.offer}
        />
      );
    default:
      return (
        <>
          <GroupRouteScreen route={route} services={services} />
          <GroupGuide route={route} guide={guide} />
        </>
      );
  }
}

/** The current route's screen, with the store and sync loop provided to `useGroup`. */
export function App({ services, initialSeed = null, persistence = null }: AppProps) {
  const route = useRoute();
  // A pasted invite's seed, or one first run held, travels here in memory, never in the address bar.
  const [heldSeed, holdSeed] = useState<Uint8Array | null>(initialSeed);
  const guide = useGuideOffer(services.guide);
  const groupServices = useMemo(
    () => ({ store: services.store, sync: services.sync }),
    [services.store, services.sync],
  );
  return (
    <GroupServicesContext value={groupServices}>
      <Screen
        route={route}
        services={services}
        heldSeed={heldSeed}
        holdSeed={holdSeed}
        persistence={persistence}
        guide={guide}
      />
    </GroupServicesContext>
  );
}
