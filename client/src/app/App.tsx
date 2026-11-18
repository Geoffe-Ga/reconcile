/**
 * The app: hash routes to screens (spec §8), on the services `main.tsx` builds.
 *
 * Screens only show things and report what people did. This file turns those
 * reports into actions on the store and the relay, and moves between routes.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apply, type ApplyValues, forgetJoined } from '../door/apply';
import { sendInvite } from '../door/inbox';
import { type OpenPage, parseDoorPayload } from '../door/page';
import { can, type Level } from '../engine/capabilities';
import type { GroupState, Proposal } from '../engine/fold';
import { removedFrom } from '../engine/removal';
import { ownBallot } from '../engine/ownBallot';
import { isPriority } from '../engine/priority';
import { Applications, type DoorCards } from '../screens/Applications';
import { GroupChangeLog } from '../screens/ChangeLog';
import { Composer, type ComposeOutcome } from '../screens/Composer';
import { CreateGroup, type CreateOutcome } from '../screens/CreateGroup';
import { Dispatches } from '../screens/Dispatches';
import { DissolveComposer } from '../screens/DissolveComposer';
import { type AddPlace, DocumentView } from '../screens/DocumentView';
import { FrontDoor } from '../screens/FrontDoor';
import { GroupHome } from '../screens/GroupHome';
import { RecoveryContacts } from '../screens/RecoveryContacts';
import { GroupRules } from '../screens/GroupRules';
import {
  GroupArchived,
  GroupMissing,
  GroupSettingUp,
  GroupUnconfirmed,
} from '../screens/GroupStatus';
import { BringCard } from '../screens/BringCard';
import { Join } from '../screens/Join';
import { type CardStep, type DoorCardStep, ReconcileCard } from '../screens/ReconcileCard';
import { LinkNewDevice } from '../screens/LinkNewDevice';
import { LinkThisDevice } from '../screens/LinkThisDevice';
import { NewDocumentComposer } from '../screens/NewDocumentComposer';
import { MoveComposer } from '../screens/MoveComposer';
import type { OptIn } from '../engine/optIns';
import { OptInComposer, type OptInOutcome } from '../screens/OptInComposer';
import { Personal } from '../screens/Personal';
import { PersonalDocument } from '../screens/PersonalDocument';
import { PriorityComposer } from '../screens/PriorityComposer';
import { ProposalView } from '../screens/ProposalView';
import { ProtectComposer } from '../screens/ProtectComposer';
import { RemovalComposer } from '../screens/RemovalComposer';
import { AddSection, RemoveSection } from '../screens/SectionComposer';
import { SendDispatch } from '../screens/SendDispatch';
import { type NotifyGroup, Settings } from '../screens/Settings';
import { SharedPage } from '../screens/SharedPage';
import type { SeatNumber } from '../engine/stewards';
import type { GuideRecord } from '../platform/guide';
import type { Persistence } from '../platform/persist';
import { Start, type StartFollowing, type StartRequest } from '../screens/Start';
import { aimAt } from './aimedSection';
import { usePullBack, useSteadyPage } from './barGestures';
import { LinkBar } from './LinkBar';
import type { SearchRecord } from './search';
import { loadSearchRecords } from './searchLoad';
import type { OpenableLink } from './linkKind';
import { openPasted } from './openPasted';
import { TabBar } from './TabBar';
import { StewardComposer, type StewardOutcome } from '../screens/StewardComposer';
import { dismissed } from '../store/applications';
import { dispatchOf, notesElsewhere, skipCarry } from '../store/carry';
import { coalitionKeys, type HeldCoalition } from '../store/coalitions';
import type { Group, Me } from '../store/db';
import { type GroupDrafts, groupDrafts } from '../store/drafts';
import { foldGroup } from '../store/expiry';
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
import { HeldShareCard } from './HeldShares';
import { CoalitionSection } from './CoalitionSection';
import {
  coalitionRows,
  misstatedSeat,
  sealedSeatMotion,
  sitsInFormed,
  withMotionWords,
} from './coalitionLines';
import {
  admitCard,
  bringCard,
  broughtTo,
  type CardGroup,
  type CardValues,
  type FoundCard,
  lookupCard,
  makeCard,
  postCard,
  takePart,
} from './reconcile';
import type { Scores } from './Ballot';
import {
  bringDoorCard,
  cardGroupsAt,
  closeDoorCard,
  type DoorTarget,
  makeDoorCard,
} from './doorCards';
import { FirstRunGuide } from './FirstRunGuide';
import {
  addVersion,
  askPriority,
  castBallot,
  chooseLevel,
  type DispatchValues,
  type DissolveValues,
  propose,
  proposeDispatch,
  proposeDissolve,
  proposeRemoval,
  proposeRules,
  proposeSteward,
  type RisingValues,
  type RemovalValues,
  respondToRemoval,
  type RulesValues,
  sendDispatch,
  type StewardValues,
  suspend,
  type PriorityValues,
  type ProposalValues,
  type VersionValues,
  vouch,
} from './proposals';
import { CoalitionRouteScreen, FollowScreen } from './CoalitionScreens';
import {
  type BareRoute,
  type CoalitionRoute,
  type GroupRoute,
  isBare,
  navigate,
  replaceRoute,
  type Route,
  routeHref,
  useRoute,
} from './router';
import type { AppServices } from './services';
import type { ChatDetails, ChatMoment } from './chatMessages';
import { chatPayload, shareOrCopy } from './share';
import type { VoteLinkPort } from './TellYourGroup';
import { locateVote, type VoteTarget, voteLinkOf } from './voteLink';
import { relayMinuteNow } from './time';
import { GroupServicesContext, type GroupView, useCoalitionList, useGroup } from './useGroup';
import { useGroupList, useGroups } from './useGroupList';
import { useNow } from './useNow';
import { usePasskeyState } from './usePasskeyState';
import { useHeardRelay, usePersonalList } from './usePersonalList';
import { DiscoverScreen } from './DiscoverScreen';
import { chooseContacts } from '../store/recovery';
import { approveRecovery, holdViews, resendRelease } from '../recovery/holder';
import { recoverSession, startRecovery, stopRecovery } from '../recovery/request';
import { HelpRecover } from '../screens/HelpRecover';
import { Landing } from '../screens/Landing';
import { RecoverStart } from '../screens/RecoverStart';
import { VoteLink } from '../screens/VoteLink';
import { messages } from './messages';
import { RecoveryAlert } from './RecoveryAlert';
import { useRecovery } from './useRecovery';
import { useRecoveryAlert } from './useRecoveryAlert';
import { useSentApplications } from './useSent';
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
  /** Opens the invite a front door's reply brought (#121), its seed held in memory. */
  readonly onOpenInvite: (seed: Uint8Array) => void;
  readonly persistence: Persistence | null;
}

/**
 * The recovery alert (#118) while a recovery of this person waits, with
 * Cancel this recovery; null when there is none. Start shows it first, and
 * every group home first among its quiet cards.
 */
function useAlertCard(services: AppServices): ReactNode {
  const { summary, cancel } = useRecoveryAlert(services);
  return summary === null ? null : <RecoveryAlert summary={summary} onCancel={cancel} />;
}

/** The coalitions this device follows (#124), once each has its genesis, as Start lists them. */
function followingOf(coalitions: readonly HeldCoalition[]): StartFollowing[] {
  return coalitions.flatMap(({ entry, state }) => {
    if (entry.following !== true || state.group === null || state.coalition === null) return [];
    const groups = state.coalition.seats.map((seat) => seat.name);
    return [{ coalitionId: state.group, name: state.name, groups }];
  });
}

function StartScreen(props: StartScreenProps) {
  const { services, onOpenInvite, persistence } = props;
  const groups = useGroupList(services.store);
  const alert = useAlertCard(services);
  const coalitions = useCoalitionList(services.store);
  const following = useMemo(() => followingOf(coalitions ?? []), [coalitions]);
  const sent = useSentApplications(services.store);
  const requests = useMemo(
    () =>
      (sent ?? []).map((application): StartRequest => ({
        id: application.id,
        groupName: application.groupName,
        sentAt: application.sentAt,
        invite: application.invite ?? null,
      })),
    [sent],
  );
  const onRestore = useCallback(
    (bytes: Uint8Array, passphrase: string) => restoreBackup(services, bytes, passphrase),
    [services],
  );
  return groups === null || sent === null ? null : (
    <Start
      groups={groups}
      requests={requests}
      onOpenInvite={onOpenInvite}
      following={following}
      persistence={persistence}
      onRestore={onRestore}
      alert={alert}
    />
  );
}

/**
 * The groups on this device that may propose reconciling at the door
 * `payload` names (#426), read once per door; none until the store answers,
 * or for a link that doesn't parse.
 */
function useCardGroups(services: AppServices, payload: string): readonly CardGroup[] {
  const [answer, setAnswer] = useState<{ payload: string; groups: readonly CardGroup[] } | null>(
    null,
  );
  useEffect(() => {
    const address = parseDoorPayload(payload);
    if (address === null) return;
    let live = true;
    cardGroupsAt(services, address).then(
      (groups) => {
        if (live) setAnswer({ payload, groups });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [services, payload]);
  return answer?.payload === payload ? answer.groups : NO_CARD_GROUPS;
}

/** No groups to propose reconciling from: one shared empty list, so it never looks changed. */
const NO_CARD_GROUPS: readonly CardGroup[] = [];

/** Propose reconciling's Submit at a door (#426): the card made, its post leaving it at the door. */
async function makeCardAt(
  services: AppServices,
  door: DoorTarget,
  groupId: string,
  values: CardValues,
): Promise<DoorCardStep> {
  const made = await makeDoorCard(services, groupId, values, door);
  return made.outcome === 'too-large'
    ? { kind: 'too-large' }
    : { kind: 'queued', proposalId: made.proposalId, post: made.post };
}

/**
 * A group's front door (#121): its page, and Send, which keeps its reply key
 * on this device, offering a copy of any of this device's personal
 * Documents (#425), which it reads without a key, and Propose reconciling
 * with this group for a device in a group that may (#426).
 */
function DoorScreen({
  services,
  payload,
}: {
  readonly services: AppServices;
  readonly payload: string;
}) {
  const sent = useSentApplications(services.store);
  const documents = usePersonalList(services.store);
  const cardGroups = useCardGroups(services, payload);
  const onMakeCard = useCallback(
    (address: Uint8Array, page: OpenPage, groupId: string, values: CardValues) =>
      makeCardAt(services, { address, page }, groupId, values),
    [services],
  );
  const asked = useCallback(
    (address: string) => (sent ?? []).some((application) => application.door === address),
    [sent],
  );
  const onApply = useCallback(
    (address: Uint8Array, page: OpenPage, values: ApplyValues) =>
      apply(services, address, page, values),
    [services],
  );
  return sent === null || documents === null ? null : (
    <FrontDoor
      payload={payload}
      reader={services}
      asked={asked}
      onApply={onApply}
      documents={documents}
      cardGroups={cardGroups}
      onMakeCard={onMakeCard}
    />
  );
}

/**
 * A group's push switch (#99): named once its genesis is back, and gone while
 * it's leaving or once it's a read-only archive (#108).
 */
function notifyGroupOf(group: Group): NotifyGroup | null {
  const state = foldGroup(group);
  // A read-only archive takes nothing new, push included (#108).
  if (state.group === null || group.leaving !== undefined || group.archived !== undefined) {
    return null;
  }
  return { groupId: group.groupId, name: state.name, on: group.push !== undefined };
}

/**
 * Settings (#78, #95, #96, #99, #109): Notifications, Save a backup with the
 * relay backup's line (#97), Recovery contacts (#109), Restore a backup, Link
 * a new device, Lock with a passkey, and Erase.
 */
function SettingsScreen({ services }: { readonly services: AppServices }) {
  const groups = useGroupList(services.store);
  const switches = useGroups(services.store, notifyGroupOf);
  const relayBackup = useRelayBackupStatus(services.store);
  const recovery = useRecovery(services.store);
  const { push, passkey } = services;
  const passkeyState = usePasskeyState(passkey, services.store);
  const loaded = groups !== null && switches !== null && relayBackup !== null && recovery !== null;
  return !loaded || passkeyState === null ? null : (
    <Settings
      notify={{
        availability: push.availability(),
        groups: switches.filter((group) => group !== null),
        onTurnOn: (groupId) => push.turnOn(groupId),
        onTurnOff: (groupId) => push.turnOff(groupId),
      }}
      hasGroups={groups.length > 0}
      relayBackup={relayBackup}
      recovery={{
        status: recovery.status,
        held: recovery.held,
        canChoose: recovery.groups.length > 0,
        recovered: recovery.recovered,
        elsewhere: recovery.elsewhere,
      }}
      onMake={(passphrase) => makeBackup(services, passphrase)}
      onSave={(backup) => saveBackup(services, backup)}
      onRestore={(bytes, passphrase) => restoreBackup(services, bytes, passphrase)}
      onErase={services.erase}
      passkey={{
        ...passkeyState,
        onCreate: () => passkey.create(),
        onProtect: (id) => passkey.protect(id),
      }}
    />
  );
}

/**
 * Whether the device keeps a relay backup key (#97), kept current as the
 * store changes, or null until the store answers: what Personal and each
 * personal Document's line on where they go depends on (#248).
 */
function useKeepsRelayBackup(store: AppServices['store']): boolean | null {
  const status = useRelayBackupStatus(store);
  return status === null ? null : status.kind !== 'off';
}

/**
 * Choose recovery contacts (#109): the picker, from the people in this
 * device's groups. Saving chooses them, then goes back to Settings, where
 * their status shows.
 */
function RecoveryScreen({ services }: { readonly services: AppServices }) {
  const recovery = useRecovery(services.store);
  return recovery === null ? null : (
    <RecoveryContacts
      groups={recovery.groups}
      current={recovery.status}
      recovered={recovery.recovered && recovery.status === null}
      onSave={async (choice) => {
        await chooseContacts(services, choice);
        replaceRoute({ name: 'settings' });
      }}
    />
  );
}

/** A stored group as it is, for `useGroups`. */
const wholeGroup = (group: Group): Group => group;

/**
 * Recover with my contacts (#118), on a new device: keeps a request and
 * shows its code, shares it with fixed words and the app's address beside
 * it (the code's whole point is to reach the person's contacts), and polls
 * until a backup opens, then asks the person whether its groups are theirs
 * (#398). On Yes it restores them, syncs and opens the picker, which asks
 * the person to choose their contacts again. Stop recovering forgets the code.
 */
function RecoverScreen({ services }: { readonly services: AppServices }) {
  const start = useCallback(() => startRecovery(services), [services]);
  const session = useMemo(() => recoverSession(services), [services]);
  const onShare = useCallback(
    (code: string) =>
      shareOrCopy(
        { text: `${messages.recover.message} ${code}`, url: `${services.origin}/` },
        services,
      ),
    [services],
  );
  const onRestored = useCallback(() => {
    void services.sync.syncOnce();
    replaceRoute({ name: 'recovery' });
  }, [services]);
  const onStop = useCallback(async () => {
    await stopRecovery(services);
    replaceRoute({ name: 'start' });
  }, [services]);
  return (
    <RecoverStart
      start={start}
      poll={session.poll}
      confirm={session.confirm}
      decline={session.decline}
      onShare={onShare}
      onRestored={onRestored}
      onStop={onStop}
    />
  );
}

/**
 * Help someone recover (#118), on a recovery contact's device: the shares it
 * holds, each recovery it's helping with read at the relay's minute as this
 * device estimates it, Approve, and Send again for a share that went with
 * the wrong second number (#398).
 */
function HelpRecoverScreen({ services }: { readonly services: AppServices }) {
  const recovery = useRecovery(services.store);
  const groups = useGroups(services.store, wholeGroup);
  const deviceNow = useNow(services.now);
  if (recovery === null || groups === null) return null;
  const holds = holdViews(groups, (group) => relayMinuteNow(group, deviceNow));
  return (
    <HelpRecover
      held={recovery.held}
      holds={holds}
      onApprove={(approval) => approveRecovery(services, approval)}
      onResend={(resend) => resendRelease(services, resend)}
    />
  );
}

/**
 * Personal (#93): this device's personal Documents, and the id a new one
 * opens at, at the relay minute that says which shares wait for the person
 * (#339, #347).
 */
function PersonalScreen({ services }: { readonly services: AppServices }) {
  const documents = usePersonalList(services.store);
  const relayBackup = useKeepsRelayBackup(services.store);
  const relayNow = useHeardRelay(services.store);
  // One id per visit: nothing is stored under it until that Document's first save.
  const [newId] = useState(newPersonalId);
  return documents === null ? null : (
    <Personal documents={documents} newId={newId} relayNow={relayNow} relayBackup={relayBackup} />
  );
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
  const relayBackup = useKeepsRelayBackup(services.store);
  return (
    <PersonalDocument
      id={id}
      documents={services.store}
      now={services.now}
      onDeleted={onDeleted}
      sharing={sharing}
      relayBackup={relayBackup}
    />
  );
}

/**
 * Link a new device (#96), on the existing device: a fresh code each time it
 * opens, once this session holds the unlocked keys (#95).
 */
function LinkNewScreen({ services }: { readonly services: AppServices }) {
  const ready = useCallback(() => services.store.requireUnlocked(), [services]);
  const start = useCallback(() => offerLink(services), [services]);
  return <LinkNewDevice ready={ready} start={start} copyText={services.copyText} />;
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
      // An invite a front door's reply brought is spent once joined (#121).
      if (heldSeed !== null) await forgetJoined(services.store, heldSeed).catch(() => undefined);
      releaseSeed();
      offerGuide(groupId);
      replaceRoute({ name: 'group', groupId });
      return true;
    },
    [services, heldSeed, releaseSeed, offerGuide],
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
  /**
   * True for a screen that writes something new: a dissolved group (#108),
   * a group a vote removed this member from (#115), and a copy back from a
   * backup that hasn't heard from the group (#231), show they only read.
   */
  readonly writes?: boolean;
  readonly children: (group: ReadyGroup) => ReactNode;
}

/**
 * What a screen that writes shows in its place for a group that only reads:
 * a dissolved group's page (#108), a removed member's (#115), or a copy back
 * from a backup that hasn't heard from the group (#231); null for one that
 * takes new things. `me` is this member's key.
 */
function readOnlyPage(
  groupId: string,
  state: GroupState,
  me: string,
  unconfirmed: boolean,
): ReactNode {
  const removed = removedFrom(state, me) !== undefined;
  if (state.dissolved !== null || removed) {
    return <GroupArchived groupId={groupId} name={state.name} removed={removed} />;
  }
  return unconfirmed ? <GroupUnconfirmed groupId={groupId} name={state.name} /> : null;
}

/** Renders `children` once the group is ready, or says why it isn't. */
function GroupGate({ groupId, writes = false, children }: GroupGateProps) {
  const group = useGroup(groupId);
  const { loaded, state, me } = group;
  if (!loaded) return null;
  if (state === null || me === null) return <GroupMissing />;
  if (state.group === null) return <GroupSettingUp />;
  const page = writes ? readOnlyPage(groupId, state, me.author, group.unconfirmed) : null;
  if (page !== null) return page;
  // A coalition motion takes its title and why from its coalition (#114).
  return children({ ...group, state: withMotionWords(state, group.coalitions), me });
}

interface GroupScreenProps {
  readonly services: AppServices;
  readonly groupId: string;
}

/**
 * The reconcile cards at `groupId`'s door (#426): those this device read,
 * less any it has queued a close of, how one opens, and Bring it to a vote,
 * which opens the group's new Proposal, and Dismiss, both closing it for
 * every member.
 */
function doorCardsFor(services: AppServices, groupId: string, group: GroupView): DoorCards {
  const closing = new Set(
    group.pending.flatMap(({ event }) =>
      event.type === 'door-card-closed' ? [event.body.card] : [],
    ),
  );
  return {
    held: group.cards.filter((card) => !closing.has(card.id)),
    lookup: (seed) => lookupCard(services, seed),
    onBring: async (card, found, yourName) => {
      const proposalId = await bringDoorCard(services, groupId, card, found, yourName);
      navigate({ name: 'proposal', groupId, proposalId });
      return true;
    },
    onDismiss: async (card) => {
      await closeDoorCard(services, groupId, card);
    },
  };
}

/**
 * The front door's Applications for group home (#121), while the door is
 * open in effect and this member may invite; otherwise none. Its reconcile
 * cards come with it (#426).
 */
function applicationsFor(services: AppServices, group: GroupView & { state: GroupState; me: Me }) {
  const { state, me } = group;
  const groupId = state.group ?? '';
  const open = state.dissolved === null && state.optIns.frontDoor !== false;
  if (!open || !can(state, me.author, 'invite')) return undefined;
  return (
    <Applications
      state={state}
      me={me.author}
      applications={group.applications}
      onInvite={(id) =>
        sendInvite(
          { ...services, makeInvite: () => makeInvite(services, groupId, services.origin) },
          groupId,
          id,
        )
      }
      onDismiss={(id) =>
        services.store.updateInbox(groupId, (held) =>
          held === undefined ? held : dismissed(held, id),
        )
      }
      cards={doorCardsFor(services, groupId, group)}
    />
  );
}

function GroupScreen({ services, groupId }: GroupScreenProps) {
  const deviceNow = useNow(services.now);
  const alert = useAlertCard(services);
  return (
    <GroupGate groupId={groupId}>
      {(group) => (
        <GroupHome
          applications={applicationsFor(services, group)}
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
          unconfirmed={group.unconfirmed}
          backupCard={
            group.suggestBackup && !group.leaving ? (
              <BackupCard onNotNow={() => services.store.markBackup([groupId], 'not-now')} />
            ) : null
          }
          alertCard={alert === null ? null : <div className="backup-slot">{alert}</div>}
          recoveryCard={
            <HeldShareCard
              held={group.newShares}
              onDismiss={(ids) => services.store.markRecoverySeen(groupId, ids)}
            />
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
          coalitions={<Coalitions services={services} group={group} />}
          coalitionNames={coalitionNames(group.coalitions)}
        />
      )}
    </GroupGate>
  );
}

/** Each coalition on this device's name by its genesis id, which tags its motions (#120). */
function coalitionNames(coalitions: GroupView['coalitions']): Record<string, string> {
  return Object.fromEntries(
    coalitions.flatMap(({ state }) => (state.group === null ? [] : [[state.group, state.name]])),
  );
}

/**
 * Group home's Coalitions (#114): each coalition the group proposed or
 * joined, and Reconcile with another group for whoever may start one, while
 * the group takes new things and this device reads its current key.
 */
function Coalitions({ services, group }: { services: AppServices; group: ReadyGroup }) {
  const { state, me, coalitions, leaving, unconfirmed, keyChange } = group;
  const groupId = state.group ?? '';
  const open = !leaving && !unconfirmed && state.dissolved === null && keyChange === null;
  return (
    <CoalitionSection
      groupId={groupId}
      rows={coalitionRows(state, me.author, coalitions)}
      starts={open && can(state, me.author, 'propose')}
      onTakePart={(entryId, name) => takePart(services, entryId, groupId, name)}
      makeCardLink={async (entryId) =>
        postCard(services, await admitCard(services, entryId, groupId), services.origin)
      }
      copyText={services.copyText}
      sharing={services}
    />
  );
}

/** Reconcile with another group (#114): the card's form, then its link. */
function ReconcileScreen({ services, groupId }: GroupScreenProps) {
  const onMake = async (values: CardValues): Promise<CardStep> => {
    const made = await makeCard(services, groupId, values);
    if (made.outcome === 'too-large') return { kind: 'too-large' };
    const { card, proposalId } = made;
    return { kind: 'queued', proposalId, post: () => postCard(services, card, services.origin) };
  };
  return (
    <GroupGate groupId={groupId} writes>
      {({ state }) => (
        <ReconcileCard
          groupId={groupId}
          groupName={state.name}
          onMake={onMake}
          copyText={services.copyText}
          sharing={services}
        />
      )}
    </GroupGate>
  );
}

interface BringScreenProps {
  readonly services: AppServices;
  readonly payload: string | null;
  readonly heldSeed: Uint8Array | null;
  /** Lets go of the seed held in memory, once Bring or Not now is done with it. */
  readonly releaseSeed: () => void;
}

/**
 * Bring a card (#114): the card, then the group it goes to, whose new
 * Proposal opens after, or the coalition, whose home opens (#122).
 */
function BringScreen({ services, payload, heldSeed, releaseSeed }: BringScreenProps) {
  const lookup = useCallback((seed: Uint8Array) => lookupCard(services, seed), [services]);
  const onBring = useCallback(
    async (found: FoundCard, groupId: string, name: string) => {
      const proposalId = await bringCard(services, found, groupId, name);
      const next = await broughtTo(services, found, groupId, proposalId);
      releaseSeed();
      replaceRoute(next);
      return true;
    },
    [services, releaseSeed],
  );
  const onNotNow = useCallback(() => {
    releaseSeed();
    replaceRoute({ name: 'start' });
  }, [releaseSeed]);
  return (
    <BringCard
      payload={payload}
      heldSeed={heldSeed}
      lookup={lookup}
      onBring={onBring}
      onNotNow={onNotNow}
    />
  );
}

/** One of the group's Documents (#92), by its id from the route, or its first. */
function DocumentScreen({
  services,
  groupId,
  documentId,
}: GroupScreenProps & { readonly documentId?: string }) {
  const openComposer = (atomId: string) => {
    navigate({ name: 'propose', groupId, atomId });
  };
  // After an Atom, its Document is the Atom's; at the start, the route names the Document (#92).
  // A header's choice names its level (#103).
  const openAdd = ({ document, after, heading }: AddPlace) => {
    navigate({
      name: 'add',
      groupId,
      after,
      ...(after === null ? { document } : {}),
      ...(heading === undefined ? {} : { heading }),
    });
  };
  const openRemove = (atomId: string) => {
    navigate({ name: 'remove', groupId, atomId });
  };
  const openMove = (atomId: string) => {
    navigate({ name: 'move', groupId, atomId });
  };
  const openProtect = (atomId: string) => {
    navigate({ name: 'protect', groupId, atomId });
  };
  return (
    <GroupGate groupId={groupId}>
      {({ state, me, leaving, cleared, unconfirmed }) => (
        <DocumentView
          state={state}
          me={me.author}
          {...(documentId === undefined ? {} : { documentId })}
          onPropose={openComposer}
          onAdd={openAdd}
          onRemove={openRemove}
          onMove={openMove}
          onProtect={openProtect}
          copyText={services.copyText}
          leaving={leaving}
          unconfirmed={unconfirmed}
          {...(cleared === null ? {} : { kept: cleared.tallies })}
        />
      )}
    </GroupGate>
  );
}

/** One of the group's Documents' change log (#104), with a cleared archive's kept tallies (#108). */
function ChangeLogScreen({ groupId, documentId }: { groupId: string; documentId: string }) {
  return (
    <GroupGate groupId={groupId}>
      {({ state, cleared }) => (
        <GroupChangeLog
          state={state}
          documentId={documentId}
          {...(cleared === null ? {} : { kept: cleared.tallies })}
        />
      )}
    </GroupGate>
  );
}

/** What every composer is handed: the group, this member, its drafts, the device clock, and its two actions. */
interface ComposeProps {
  readonly state: GroupState;
  readonly me: string;
  readonly drafts: GroupDrafts;
  /** The device clock now, in ms, which the voting time's closing line counts from (#106). */
  readonly now: number;
  /** Whether this device's leave waits for the relay (#77): then composers show no form. */
  readonly leaving: boolean;
  readonly onPropose: (values: ProposalValues) => Promise<ComposeOutcome>;
  readonly onAddVersion: (values: VersionValues) => Promise<ComposeOutcome>;
  /** Asks what to focus on (#107). */
  readonly onAsk: (values: PriorityValues) => Promise<ComposeOutcome>;
}

interface ComposeScreenProps extends GroupScreenProps {
  /** The composer for the route, given what every composer is handed. */
  readonly children: (props: ComposeProps) => ReactNode;
}

/**
 * A composer's screen: proposing, adding a version or asking what to focus on
 * (#107) queues the event and replaces the composer with the Proposal, so
 * Back returns to where it opened.
 */
function ComposeScreen({ services, groupId, children }: ComposeScreenProps) {
  // One stable handle per group, so the composer reads its draft once, not on every sync.
  const drafts = useMemo(() => groupDrafts(services.store, groupId), [services.store, groupId]);
  const deviceNow = useNow(services.now);
  return (
    <GroupGate groupId={groupId} writes>
      {({ state, me, leaving }) => {
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
        const onAsk = async (values: PriorityValues): Promise<ComposeOutcome> => {
          const result = await askPriority(services, groupId, values);
          if (result.outcome === 'too-large') return result.outcome;
          // Replace the composer, so Back from the vote returns to where it opened.
          replaceRoute({ name: 'proposal', groupId, proposalId: result.proposalId });
          return result.outcome;
        };
        return children({
          state,
          me: me.author,
          drafts,
          now: deviceNow,
          leaving,
          onPropose,
          onAddVersion,
          onAsk,
        });
      }}
    </GroupGate>
  );
}

/** Ask what to focus on (#107), starting from a lapsed priority vote when there is one. */
function Ask({ again, ...props }: ComposeProps & { readonly again?: Proposal }) {
  return (
    <PriorityComposer
      state={props.state}
      me={props.me}
      now={props.now}
      leaving={props.leaving}
      onAsk={props.onAsk}
      {...(again === undefined ? {} : { again })}
    />
  );
}

/**
 * Propose again (#74): the composer for what the lapsed Proposal targets,
 * starting from it. A change opens the composer on its section, a removal the
 * removal composer, an add Add a section at its spot in its Document (#75,
 * #92), a new Document the new-Document composer (#92), a move Move this
 * section (#103), a class Proposal Protect this section (#116), and a
 * priority vote Ask what to focus on (#107).
 */
function ProposeAgain({ againId, ...props }: ComposeProps & { readonly againId: string }) {
  const again = props.state.proposals.find((proposal) => proposal.id === againId);
  if (again === undefined) return <Composer {...props} atomId="" />;
  if (isPriority(again)) return <Ask {...props} again={again} />;
  const { target } = again;
  if (target.kind === 'new-document') return <NewDocumentComposer {...props} again={again} />;
  if (target.kind === 'move') return <MoveComposer {...props} atomId={target.atom} again={again} />;
  if (target.kind === 'class') {
    return <ProtectComposer {...props} atomId={target.atom} again={again} />;
  }
  if (target.kind === 'add') {
    return <AddSection {...props} after={target.after} document={target.document} again={again} />;
  }
  if (again.text === '') return <RemoveSection {...props} atomId={again.atom} again={again} />;
  return <Composer {...props} atomId={again.atom} again={again} />;
}

interface ProposalScreenProps extends GroupScreenProps {
  readonly proposalId: string;
}

function ProposalScreen({ services, groupId, proposalId }: ProposalScreenProps) {
  return (
    <GroupGate groupId={groupId}>
      {(group) => <GroupProposal services={services} group={group} proposalId={proposalId} />}
    </GroupGate>
  );
}

/**
 * The notes this person wrote on the Dispatch `dispatch` in their other
 * groups on this device (#126), which a note here may not repeat; none while
 * they load, or for a Proposal on no rising Dispatch.
 */
function useNotesElsewhere(services: AppServices, groupId: string, dispatch: string | null) {
  const [notes, setNotes] = useState<readonly string[]>([]);
  useEffect(() => {
    let live = true;
    if (dispatch === null) return;
    notesElsewhere(services.store, groupId, dispatch).then(
      (found) => {
        if (live) setNotes(found);
      },
      // Without them the ballot refuses no note, as before #126.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [services, groupId, dispatch]);
  return notes;
}

/**
 * Whether `proposal`, a coalition's motion to take a seat above (#122), shows
 * a ballot as far as its seat goes (#375): `misstated` when the seat secret
 * its sealed target holds doesn't make the seat key it states, `checking`
 * until this device's keys are read, and null once the seat holds, or for
 * any other Proposal.
 */
function useSeatCheck(
  services: AppServices,
  proposal: Pick<Proposal, 'id' | 'target'> | undefined,
  coalitions: readonly HeldCoalition[],
): 'checking' | 'misstated' | null {
  const motion = useMemo(
    () => (proposal === undefined ? null : sealedSeatMotion(proposal, coalitions)),
    [proposal, coalitions],
  );
  const [checked, setChecked] = useState<{ readonly id: string; readonly misstated: boolean }>();
  const id = motion === null ? null : `${motion.entryId} ${motion.target.sealed}`;
  useEffect(() => {
    let live = true;
    if (motion === null || id === null) return;
    const { store } = services;
    Promise.all([store.listGroups(), store.listCoalitions()]).then(
      ([groups, entries]) => {
        if (live)
          setChecked({ id, misstated: misstatedSeat(motion, coalitionKeys(groups, entries)) });
      },
      // Until the keys read, the ballot stays away.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [services, motion, id]);
  if (id === null) return null;
  if (checked?.id !== id) return 'checking';
  return checked.misstated ? 'misstated' : null;
}

interface GroupProposalProps {
  readonly services: AppServices;
  readonly group: ReadyGroup;
  readonly proposalId: string;
}

/**
 * `proposalId`'s vote link in `group` (#472, ADR-0079), with the clipboard
 * for Copy link to this vote, or undefined when it has no token.
 */
function voteLinkFor(
  services: AppServices,
  group: ReadyGroup,
  proposalId: string,
): VoteLinkPort | undefined {
  const token = group.voteToken(proposalId);
  return token === null
    ? undefined
    : { link: voteLinkOf(services.origin, token), copyText: services.copyText };
}

/**
 * One Proposal's page: its ballot, and for a Dispatch that may rise (#126),
 * this device's plan to cast this person's score from another group, with
 * Don't cast, and the notes they wrote on it elsewhere.
 */
function GroupProposal({ services, group, proposalId }: GroupProposalProps) {
  const deviceNow = useNow(services.now);
  const groupId = group.state.group ?? '';
  const proposal = group.state.proposals.find((p) => p.id === proposalId);
  const seatCheck = useSeatCheck(services, proposal, group.coalitions);
  const dispatch = proposal === undefined ? null : dispatchOf(proposal, group.coalitions);
  const notes = useNotesElsewhere(services, groupId, dispatch?.id ?? null);
  const author = group.me.author;
  const onVote = (scores: Scores, note: string) =>
    castBallot(services, groupId, { proposal: proposalId, scores, note });
  const onProposeAgain = () => {
    navigate({ name: 'again', groupId, proposalId });
  };
  const voteLink = voteLinkFor(services, group, proposalId);
  const onTell = (moment: ChatMoment, details: ChatDetails) =>
    shareOrCopy(chatPayload(moment, details, voteLink?.link ?? `${services.origin}/`), services);
  const onRespond = (text: string) =>
    respondToRemoval(services, groupId, { proposal: proposalId, text });
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
      unconfirmed={group.unconfirmed}
      {...(seatCheck === null ? {} : { seatCheck })}
      {...(group.cleared === null ? {} : { cleared: group.cleared })}
      coalitions={group.coalitions}
      onVote={onVote}
      onProposeAgain={onProposeAgain}
      onTell={onTell}
      {...(voteLink === undefined ? {} : { voteLink })}
      onRespond={onRespond}
      carry={group.carries.find((plan) => plan.motion === proposalId) ?? null}
      onSkipCarry={() => skipCarry(services.store, groupId, proposalId)}
      notesElsewhere={notes}
    />
  );
}

/** A route that opens a composer. */
type ComposeRoute = Extract<
  Route,
  {
    readonly name:
      'propose' | 'add' | 'remove' | 'move' | 'protect' | 'again' | 'newDocument' | 'priority';
  }
>;

/** The composer a route opens, given what every composer is handed. */
function composerFor(route: ComposeRoute): (props: ComposeProps) => ReactNode {
  switch (route.name) {
    case 'propose':
      return (props) => <Composer {...props} atomId={route.atomId} />;
    case 'add':
      return (props) => (
        <AddSection
          {...props}
          after={route.after}
          {...(route.document === undefined ? {} : { document: route.document })}
          {...(route.heading === undefined ? {} : { heading: route.heading })}
        />
      );
    case 'move':
      return (props) => <MoveComposer {...props} atomId={route.atomId} />;
    case 'protect':
      return (props) => <ProtectComposer {...props} atomId={route.atomId} />;
    case 'newDocument':
      return (props) => <NewDocumentComposer {...props} />;
    case 'remove':
      return (props) => <RemoveSection {...props} atomId={route.atomId} />;
    case 'again':
      return (props) => <ProposeAgain {...props} againId={route.proposalId} />;
    case 'priority':
      return (props) => <Ask {...props} />;
  }
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

function RulesScreen({ services, groupId }: GroupScreenProps) {
  return (
    <GroupGate groupId={groupId} writes>
      {({ state, me }) => (
        <GroupRules
          state={state}
          me={me.author}
          origin={services.origin}
          copyText={services.copyText}
        />
      )}
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

interface RemovalScreenProps extends GroupScreenProps {
  readonly member: string;
}

/** The removal composer (#115); sending the Proposal replaces it with the Proposal's ballot. */
function RemovalScreen({ services, groupId, member }: RemovalScreenProps) {
  const onPropose = async (values: RemovalValues) => {
    const result = await proposeRemoval(services, groupId, values);
    if (result.outcome === 'too-large') return result.outcome;
    // Replace the composer, so Back from the Proposal returns to Group home.
    replaceRoute({ name: 'proposal', groupId, proposalId: result.proposalId });
    return result.outcome;
  };
  return (
    <GroupGate groupId={groupId} writes>
      {({ state, me, leaving }) => (
        <RemovalComposer
          state={state}
          me={me.author}
          member={member}
          leaving={leaving}
          onPropose={onPropose}
        />
      )}
    </GroupGate>
  );
}

/** The group's Dispatches (#112), newest first, with this device's own while they wait. */
function DispatchesScreen({ groupId }: { readonly groupId: string }) {
  return (
    <GroupGate groupId={groupId}>
      {({ state, me, pending, reachable, leaving, unconfirmed }) => (
        <Dispatches
          state={state}
          me={me.author}
          pending={pending}
          reachable={reachable}
          leaving={leaving}
          unconfirmed={unconfirmed}
        />
      )}
    </GroupGate>
  );
}

/**
 * Send a Dispatch (#112); sending it replaces the form with the group's
 * Dispatches. Once the group sits in a formed coalition, it may put the
 * Dispatch to a vote with a ceiling instead (#126), which replaces the form
 * with that Proposal's ballot.
 */
function SendDispatchScreen({ services, groupId }: GroupScreenProps) {
  const onSend = async (values: DispatchValues) => {
    await sendDispatch(services, groupId, values);
    // Replace the form, so Back from the Dispatches doesn't open it again.
    replaceRoute({ name: 'dispatches', groupId });
  };
  const onPropose = async (values: RisingValues) => {
    const result = await proposeDispatch(services, groupId, values);
    if (result.outcome === 'proposed') {
      replaceRoute({ name: 'proposal', groupId, proposalId: result.proposalId });
    }
  };
  return (
    <GroupGate groupId={groupId} writes>
      {({ state, me, leaving, coalitions }) => (
        <SendDispatch
          state={state}
          me={me.author}
          leaving={leaving}
          onSend={onSend}
          {...(sitsInFormed(state, coalitions) ? { onPropose } : {})}
        />
      )}
    </GroupGate>
  );
}

/** The screen for a route inside one group. */
function GroupRouteScreen({ route, services }: { route: GroupRoute; services: AppServices }) {
  const { groupId } = route;
  switch (route.name) {
    case 'group':
      return <GroupScreen services={services} groupId={groupId} />;
    case 'document':
      return (
        <DocumentScreen
          key={route.documentId ?? ''}
          services={services}
          groupId={groupId}
          {...(route.documentId === undefined ? {} : { documentId: route.documentId })}
        />
      );
    case 'proposal':
      return <ProposalScreen services={services} groupId={groupId} proposalId={route.proposalId} />;
    case 'documentLog':
      return (
        <ChangeLogScreen key={route.documentId} groupId={groupId} documentId={route.documentId} />
      );
    case 'rules':
      return <RulesScreen services={services} groupId={groupId} />;
    case 'dispatches':
      return <DispatchesScreen groupId={groupId} />;
    default:
      return <FormRouteScreen route={route} services={services} />;
  }
}

/** A route inside one group whose screen is a form of its own. */
type FormRoute =
  | Extract<
      GroupRoute,
      { name: 'steward' | 'optIn' | 'dissolve' | 'sendDispatch' | 'removal' | 'reconcile' }
    >
  | ComposeRoute;

/**
 * The screen for a route inside one group that opens a form of its own: the
 * steward (#102), opt-in (#117), dissolve (#108) and removal (#115)
 * composers, Reconcile with another group (#114), Send a Dispatch (#112), and
 * the composers that propose a change, add or remove a section (#75), propose
 * a new Document (#92), ask what to focus on (#107), or propose a lapsed
 * Proposal again (#74).
 */
function FormRouteScreen({ route, services }: { route: FormRoute; services: AppServices }) {
  const { groupId } = route;
  switch (route.name) {
    case 'steward':
      return (
        <StewardScreen
          services={services}
          groupId={groupId}
          seat={route.seat}
          recall={route.recall}
        />
      );
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
    case 'sendDispatch':
      return <SendDispatchScreen services={services} groupId={groupId} />;
    case 'removal':
      return <RemovalScreen services={services} groupId={groupId} member={route.member} />;
    case 'reconcile':
      return <ReconcileScreen services={services} groupId={groupId} />;
    default:
      return (
        <ComposeScreen services={services} groupId={groupId}>
          {composerFor(route)}
        </ComposeScreen>
      );
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

interface BareScreenProps {
  readonly route: BareRoute;
  readonly services: AppServices;
  readonly guide: GuideOffer;
}

/**
 * A page that takes no argument: Create group, Settings, either side of
 * linking, the recovery picker, or either side of recovering with contacts.
 */
function BareScreen({ route, services, guide }: BareScreenProps) {
  switch (route.name) {
    case 'create':
      return <CreateScreen services={services} offerGuide={guide.offer} />;
    case 'settings':
      return <SettingsScreen services={services} />;
    case 'linkNew':
      return <LinkNewScreen services={services} />;
    case 'linkThis':
      return <LinkThisScreen services={services} />;
    case 'recovery':
      return <RecoveryScreen services={services} />;
    case 'recover':
      return <RecoverScreen services={services} />;
    case 'helpRecover':
      return <HelpRecoverScreen services={services} />;
  }
}

/** A route that names no group or coalition and carries no link: the device's own pages. */
type PlainRoute = Exclude<Route, GroupRoute | CoalitionRoute | { readonly payload: unknown }>;

/**
 * A route that carries a link's payload: Join (#73), a shared page (#105), a
 * front door (#121), a reconcile card (#114) and a vote (#472).
 */
type LinkRoute = Extract<Route, { readonly payload: unknown }>;

interface PlainScreenProps extends Omit<ScreenProps, 'route' | 'heldSeed' | 'holdSeed'> {
  readonly route: PlainRoute;
  /** Opens the invite a front door's reply brought (#121), its seed held in memory. */
  readonly openInvite: (seed: Uint8Array) => void;
}

/** Start, Personal, and the pages that take no argument (`BareScreen`). */
function PlainScreen(props: PlainScreenProps) {
  const { route, services, persistence, guide, openInvite } = props;
  if (isBare(route)) return <BareScreen route={route} services={services} guide={guide} />;
  switch (route.name) {
    case 'start':
      return (
        <StartScreen services={services} onOpenInvite={openInvite} persistence={persistence} />
      );
    case 'personal':
      return <PersonalScreen services={services} />;
    case 'discover':
      return <DiscoverScreen store={services.store} />;
    case 'personalDocument':
      // Keyed by id, so another Document starts its editor afresh.
      return <PersonalDocumentScreen key={route.id} services={services} id={route.id} />;
  }
}

interface LinkScreenProps extends Omit<ScreenProps, 'route' | 'holdSeed' | 'persistence'> {
  readonly route: LinkRoute;
  readonly releaseSeed: () => void;
}

/** Join, a shared page, a front door, a vote, a card and a follow link: each reads what follows its link's `#`. */
function LinkScreen({ route, services, heldSeed, releaseSeed, guide }: LinkScreenProps) {
  switch (route.name) {
    case 'follow':
      return (
        <FollowScreen
          services={services}
          payload={route.payload}
          heldSeed={heldSeed}
          releaseSeed={releaseSeed}
        />
      );
    case 'card':
      return (
        <BringScreen
          services={services}
          payload={route.payload}
          heldSeed={heldSeed}
          releaseSeed={releaseSeed}
        />
      );
    case 'shared':
      // Root shows a share link's page before first run; App shows it too, on the same relay.
      return <SharedPage payload={route.payload} reader={services} />;
    case 'door':
      return <DoorScreen services={services} payload={route.payload} />;
    case 'vote':
      // Keyed by the token, so another vote link looks afresh.
      return <VoteLinkScreen key={route.payload} services={services} token={route.payload} />;
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
  }
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
  if ('groupId' in route) {
    return (
      <>
        <GroupRouteScreen route={route} services={services} />
        <GroupGuide route={route} guide={guide} />
      </>
    );
  }
  // A coalition's home, Document and composer (#120).
  if ('coalitionId' in route) return <CoalitionRouteScreen route={route} services={services} />;
  if ('payload' in route) {
    return (
      <LinkScreen
        route={route}
        services={services}
        heldSeed={heldSeed}
        releaseSeed={releaseSeed}
        guide={guide}
      />
    );
  }
  return (
    <PlainScreen
      route={route}
      services={services}
      persistence={persistence}
      guide={guide}
      openInvite={openInvite}
    />
  );
}

/** Opens the Proposal a vote link names, in the link's place, so Back skips it (#472). */
function openVote(target: VoteTarget): void {
  replaceRoute({ name: 'proposal', ...target });
}

interface VoteLinkScreenProps {
  readonly services: AppServices;
  readonly token: string;
}

/**
 * A vote link (#472, ADR-0079 §3): matches the token across the device's
 * groups, waiting for the sync pass under way before it says the vote isn't
 * on this device.
 */
function VoteLinkScreen({ services, token }: VoteLinkScreenProps) {
  const locate = useCallback(() => locateVote(services.store, token), [services, token]);
  const waitForSync = useCallback(() => services.sync.syncOnce(), [services]);
  return <VoteLink locate={locate} waitForSync={waitForSync} onFound={openVote} />;
}

/** Opens a search result at its own page, a section's Document scrolled to it (#445). */
function goToResult(record: SearchRecord): void {
  if (record.section !== undefined) aimAt(record.section);
  navigate(record.route);
}

/** Props for {@link Frame}. */
interface FrameProps {
  readonly route: Route;
  readonly holdSeed: (seed: Uint8Array | null) => void;
  readonly loadRecords: () => Promise<readonly SearchRecord[]>;
  /** The current screen: made by {@link App}, so the bar tucking away never renders it again. */
  readonly children: ReactNode;
}

/**
 * The app's frame: the link bar floating at the top (#444), over the page's
 * own scroll region, which shows around it and keeps a focused control clear
 * of it, and, on the four pages that are its places, the tab bar at the
 * bottom (#423). A swipe up the pill tucks the bar away and a pull down past
 * the page's top brings it back, with the page held steady
 * (`useSteadyPage`). The bar's state lives here, apart from the screen, so
 * the bar moving renders only the frame.
 */
function Frame({ route, holdSeed, loadRecords, children }: FrameProps) {
  // While the link bar's panel shows, the page and the tab bar under its scrim are inert (#444).
  const [barOpen, setBarOpen] = useState(false);
  // A swipe up tucks the link bar away; a pull down past the page's top brings it back.
  const [tucked, setTucked] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  const brace = useSteadyPage(page, tucked);
  const tuck = useCallback(() => {
    brace();
    setTucked(true);
  }, [brace]);
  const untuck = useCallback(() => {
    brace();
    setTucked(false);
  }, [brace]);
  usePullBack(page, tucked, untuck);
  const openLink = useCallback(
    (link: OpenableLink) => {
      openPasted(link, holdSeed);
    },
    [holdSeed],
  );
  return (
    <div className="app-frame" data-tucked={tucked}>
      <LinkBar
        onOpen={openLink}
        onPanelChange={setBarOpen}
        loadRecords={loadRecords}
        onGo={goToResult}
        tucked={tucked}
        onTuck={tuck}
        onUntuck={untuck}
      />
      <div ref={page} className="app-page" inert={barOpen}>
        {children}
      </div>
      <TabBar route={route} inert={barOpen} />
    </div>
  );
}

/** Create group, from the landing page's Start a Group once it's opened again from the app. */
function startFromAbout(): void {
  navigate({ name: 'create' });
}

/**
 * The current route's screen, with the store and sync loop provided to
 * `useGroup`, in the app's {@link Frame}. A shared page stands outside the
 * app, with neither bar (#105), and so does the landing page opened again
 * from the mark at the bar's start (`#/about`, ADR-0078): as a friend sees it
 * from the bare address, with only a way home added.
 */
export function App({ services, initialSeed = null, persistence = null }: AppProps) {
  const route = useRoute();
  // A pasted invite's seed, or one first run held, travels here in memory, never in the address bar.
  const [heldSeed, holdSeed] = useState<Uint8Array | null>(initialSeed);
  const guide = useGuideOffer(services.guide);
  const groupServices = useMemo(
    () => ({ store: services.store, sync: services.sync }),
    [services.store, services.sync],
  );
  // Search reads what this device holds, afresh each time the bar takes focus (#445).
  const loadRecords = useCallback(() => loadSearchRecords(services.store), [services.store]);
  if (route.name === 'about') {
    return <Landing onStart={startFromAbout} home={routeHref({ name: 'start' })} />;
  }
  const screen = (
    <Screen
      route={route}
      services={services}
      heldSeed={heldSeed}
      holdSeed={holdSeed}
      persistence={persistence}
      guide={guide}
    />
  );
  return (
    <GroupServicesContext value={groupServices}>
      {route.name === 'shared' ? (
        screen
      ) : (
        <Frame route={route} holdSeed={holdSeed} loadRecords={loadRecords}>
          {screen}
        </Frame>
      )}
    </GroupServicesContext>
  );
}
