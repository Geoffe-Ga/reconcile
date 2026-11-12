/**
 * A coalition's own screens (#120): its home, its Document, its change log
 * (#104) and its composer, and its room (#125), on the services `main.tsx`
 * builds, as App.tsx wires a group's.
 *
 * Each reads the coalition entries and groups on this device, folded, and
 * turns what the screens report into actions on the store: taking part
 * (#114), proposing a motion, which goes to the coalition's outbox under
 * this device's key there (ADR-0009) and to the relay at once, writing in
 * the room, which goes to the room's outbox under that same key (#125), and
 * sharing a follow link, and unfollowing a coalition this device only
 * follows (#124), which posts nothing.
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { MAX_LEVEL } from '../engine/coalition';
import { seatIn } from '../engine/crossing';
import { changeLog } from '../engine/history';
import { ChangeLogView } from '../screens/ChangeLog';
import { CoalitionHome } from '../screens/CoalitionHome';
import { Follow } from '../screens/Follow';
import { CoalitionRoom } from '../screens/CoalitionRoom';
import { CoalitionComposer, type ComposeOutcome } from '../screens/Composer';
import { CoalitionDocumentView } from '../screens/DocumentView';
import { type CardStep, ReconcileCard } from '../screens/ReconcileCard';
import { shownState } from '../store/archive';
import type { HeldCoalition } from '../store/coalitions';
import type { Group } from '../store/db';
import { roomEntryFor } from '../store/rooms';
import { groupDrafts } from '../store/drafts';
import {
  coalitionById,
  coalitionDocuments,
  coalitionHome,
  type DeviceGroup,
  documentAtoms,
  holderOf,
  sectionIsOpen,
  standingIn,
} from './coalitionHome';
import {
  followCoalition,
  type FoundFollow,
  lookupFollow,
  shareFollowLink,
  unfollow,
} from './follow';
import { coalitionHistory, type HistorySource } from './historySource';
import { messages } from './messages';
import { propose, type ProposalValues } from './proposals';
import { type CardValues, holdsCoalitionKey, makeCard, postCard, takePart } from './reconcile';
import { roomView, sendMessage } from './room';
import { type CoalitionRoute, navigate, replaceRoute } from './router';
import type { AppServices } from './services';
import { relayMinuteNow } from './time';
import { BackLink, PageHeader } from './ui';
import { useCoalitionList, useStoredGroup } from './useGroup';
import { useGroups } from './useGroupList';
import { useNow } from './useNow';

/** A group on this device as the coalition's screens read it: folded, with this person's key. */
function deviceGroupOf(group: Group): DeviceGroup {
  return {
    groupId: group.groupId,
    me: group.me.author,
    state: shownState(group),
    leaving: group.leaving !== undefined,
    archived: group.archived !== undefined,
  };
}

/** Shown when this device holds no coalition by that id, or holds it before its genesis. */
function CoalitionMissing() {
  const { coalitions } = messages;
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={coalitions.missingTitle} pageTitle={coalitions.homePageTitle} />
      <p className="lede">{coalitions.missing}</p>
    </main>
  );
}

/** A coalition on this device with its genesis back, and this device's groups. */
interface Ready {
  readonly held: HeldCoalition;
  readonly groups: readonly DeviceGroup[];
  /** Takes part under the seat of `groupId` as `name` (#114). */
  readonly onTakePart: (groupId: string, name: string) => Promise<void>;
}

interface GateProps {
  readonly services: AppServices;
  readonly coalitionId: string;
  readonly children: (ready: Ready) => ReactNode;
}

/**
 * A coalition on this device as its screens read one above it (#122): it may
 * hold a seat there, through which its groups read the room above (#344),
 * unless its copy only reads here, as a removed member's does (#115).
 */
function deviceCoalitionOf({ entry, state }: HeldCoalition): DeviceGroup {
  const { groupId, me } = entry;
  const archived = entry.archived !== undefined;
  return { groupId, me: me.author, state, leaving: false, archived, kind: 'coalition' };
}

/**
 * Renders `children` once the coalition and this device's groups are read, or
 * says it isn't here. The groups include each other coalition on this
 * device, which may hold a seat in this one (#122).
 */
function CoalitionGate({ services, coalitionId, children }: GateProps) {
  const coalitions = useCoalitionList(services.store);
  const own = useGroups(services.store, deviceGroupOf);
  if (coalitions === null || own === null) return null;
  const held = coalitionById(coalitions, coalitionId);
  if (held === undefined) return <CoalitionMissing />;
  const others = coalitions.filter((each) => each !== held).map(deviceCoalitionOf);
  const groups = [...own, ...others];
  const onTakePart = (groupId: string, name: string) =>
    takePart(services, held.entry.groupId, groupId, name);
  return children({ held, groups, onTakePart });
}

/** The group whose seat this device holds that Back returns to, or null for Your groups. */
function backFor(held: HeldCoalition, groups: readonly DeviceGroup[]) {
  const group = groups.find(
    (each) => each.kind !== 'coalition' && seatIn(each.state, held.state) !== null,
  );
  return group === undefined ? null : { groupId: group.groupId, name: group.state.name };
}

/** The group a take-part standing names, for Take part: none for any other standing. */
function takePartGroup(ready: Ready): string {
  const standing = standingIn(ready.held, ready.groups);
  return standing.kind === 'take-part' ? standing.groupId : '';
}

/**
 * Unfollows the coalition whose entry is `entryId` (#124), then goes to
 * Start, since the coalition is no longer on this device.
 */
async function unfollowAndLeave(services: AppServices, entryId: string): Promise<void> {
  await unfollow(services, entryId);
  replaceRoute({ name: 'start' });
}

/** The coalition's home (#120). */
function HomeScreen({ services, coalitionId }: Omit<GateProps, 'children'>) {
  const deviceNow = useNow(services.now);
  return (
    <CoalitionGate services={services} coalitionId={coalitionId}>
      {(ready) => {
        const view = coalitionHome(ready.held, ready.groups);
        if (view === null) return <CoalitionMissing />;
        const { entryId } = view;
        return (
          <CoalitionHome
            view={view}
            state={ready.held.state}
            now={relayMinuteNow(ready.held.entry, deviceNow)}
            back={backFor(ready.held, ready.groups)}
            onTakePart={(name) => ready.onTakePart(takePartGroup(ready), name)}
            makeFollowLink={() => shareFollowLink(services, entryId, services.origin)}
            copyText={services.copyText}
            onUnfollow={() => unfollowAndLeave(services, entryId)}
          />
        );
      }}
    </CoalitionGate>
  );
}

interface DocumentScreenProps extends Omit<GateProps, 'children'> {
  readonly documentId: string;
}

/** The coalition's history source (#104), each motion's result in a group here whose seat decides it. */
function historyOf(ready: Ready): HistorySource {
  const view = coalitionHome(ready.held, ready.groups);
  return coalitionHistory(ready.held.state, [...(view?.open ?? []), ...(view?.decided ?? [])]);
}

/** One of the coalition's Documents (#120), with Propose a change for whoever may. */
function DocumentScreen({ services, coalitionId, documentId }: DocumentScreenProps) {
  return (
    <CoalitionGate services={services} coalitionId={coalitionId}>
      {(ready) => {
        const { state } = ready.held;
        const document = coalitionDocuments(state).find((each) => each.id === documentId);
        if (document === undefined) return <CoalitionMissing />;
        const atoms = documentAtoms(state, documentId);
        const open = new Set(atoms.filter((a) => sectionIsOpen(state, a.id)).map((a) => a.id));
        return (
          <CoalitionDocumentView
            coalitionId={coalitionId}
            name={state.name}
            documentId={documentId}
            title={document.title}
            atoms={atoms}
            standing={standingIn(ready.held, ready.groups)}
            open={open}
            onPropose={(atomId) => {
              navigate({ name: 'coalitionPropose', coalitionId, atomId });
            }}
            onTakePart={(name) => ready.onTakePart(takePartGroup(ready), name)}
            copyText={services.copyText}
            history={historyOf(ready)}
          />
        );
      }}
    </CoalitionGate>
  );
}

/** One of the coalition's Documents' change log (#104), each change opening its section's history. */
function LogScreen({ services, coalitionId, documentId }: DocumentScreenProps) {
  return (
    <CoalitionGate services={services} coalitionId={coalitionId}>
      {(ready) => {
        const { state } = ready.held;
        const document = coalitionDocuments(state).find((each) => each.id === documentId);
        if (document === undefined) return <CoalitionMissing />;
        const atoms = documentAtoms(state, documentId);
        return (
          <ChangeLogView
            back={{ name: 'coalitionDocument', coalitionId, documentId }}
            title={document.title}
            rows={changeLog(state, documentId)}
            source={historyOf(ready)}
            numbers={new Map(atoms.map((atom, i) => [atom.id, i + 1]))}
          />
        );
      }}
    </CoalitionGate>
  );
}

interface ProposeScreenProps extends Omit<GateProps, 'children'> {
  readonly atomId: string;
}

/**
 * The coalition's composer (#120): proposing queues the motion in the
 * coalition's outbox, signed with this device's key there, and replaces the
 * composer with the coalition's home, where it waits for the relay.
 */
function ProposeScreen({ services, coalitionId, atomId }: ProposeScreenProps) {
  const deviceNow = useNow(services.now);
  const coalitions = useCoalitionList(services.store);
  const entryId =
    coalitions === null ? null : coalitionById(coalitions, coalitionId)?.entry.groupId;
  const drafts = useMemo(
    () => groupDrafts(services.store, entryId ?? ''),
    [services.store, entryId],
  );
  const onPropose = useCallback(
    async (values: ProposalValues): Promise<ComposeOutcome> => {
      const result = await propose(services, entryId ?? '', values, coalitionId);
      if (result.outcome === 'too-large') return result.outcome;
      replaceRoute({ name: 'coalition', coalitionId });
      return result.outcome;
    },
    [services, entryId, coalitionId],
  );
  return (
    <CoalitionGate services={services} coalitionId={coalitionId}>
      {(ready) => (
        <CoalitionComposer
          state={ready.held.state}
          atomId={atomId}
          standing={standingIn(ready.held, ready.groups)}
          drafts={drafts}
          now={deviceNow}
          onPropose={onPropose}
        />
      )}
    </CoalitionGate>
  );
}

/** Whether this person may make the coalition's card for another coalition (#122). */
function reconcilesFrom(ready: Ready): boolean {
  const level = ready.held.state.coalition?.level ?? MAX_LEVEL;
  return standingIn(ready.held, ready.groups).kind === 'proposes' && level < MAX_LEVEL;
}

/**
 * Whether this device holds the `inner` of the coalition entry `entryId`
 * (#313), read again whenever the store says anything changed; null until
 * first read.
 */
function useHoldsKey(services: AppServices, entryId: string): boolean | null {
  const [holds, setHolds] = useState<{ entryId: string; held: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      holdsCoalitionKey(services, entryId).then(
        (held) => {
          if (live) setHolds({ entryId, held });
        },
        // A failed read keeps the last answer; the next change reads again.
        () => undefined,
      );
    };
    read();
    const unsubscribe = services.store.subscribe(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [services, entryId]);
  return holds?.entryId === entryId ? holds.held : null;
}

interface ReconcileReadyProps {
  readonly services: AppServices;
  readonly ready: Ready;
  readonly coalitionId: string;
}

/**
 * The card's form once the coalition is read, or why there's none: this
 * person can't make the card, or this device doesn't hold the coalition's
 * `inner` yet, as a group admitted later doesn't until a seated group's wrap
 * for its seat arrives (#313).
 */
function ReconcileReady({ services, ready, coalitionId }: ReconcileReadyProps) {
  const entryId = ready.held.entry.groupId;
  const holds = useHoldsKey(services, entryId);
  if (!reconcilesFrom(ready)) return <CantReconcile coalitionId={coalitionId} />;
  if (holds === null) return null;
  if (!holds) {
    return <CantReconcile coalitionId={coalitionId} line={messages.card.coalitionKeyWaits} />;
  }
  const onMake = async (values: CardValues): Promise<CardStep> => {
    const made = await makeCard(services, entryId, values);
    if (made.outcome === 'too-large') return { kind: 'too-large' };
    const { card, proposalId } = made;
    return {
      kind: 'queued',
      proposalId,
      post: () => postCard(services, card, services.origin),
    };
  };
  return (
    <ReconcileCard
      groupId={entryId}
      groupName={ready.held.state.name}
      coalitionId={coalitionId}
      onMake={onMake}
      copyText={services.copyText}
    />
  );
}

/**
 * Reconcile with another coalition (#122): the card's form, from the
 * coalition's entry, for someone who proposes in it while one more level
 * stays within 3, once this device holds its `inner` (#313).
 */
function ReconcileScreen({ services, coalitionId }: Omit<GateProps, 'children'>) {
  return (
    <CoalitionGate services={services} coalitionId={coalitionId}>
      {(ready) => <ReconcileReady services={services} ready={ready} coalitionId={coalitionId} />}
    </CoalitionGate>
  );
}

/**
 * Why there's no card form here (#122): this person can't make the
 * coalition's card, or `line`, another reason.
 */
function CantReconcile({
  coalitionId,
  line = messages.card.coalitionCant,
}: {
  readonly coalitionId: string;
  readonly line?: string;
}) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'coalition', coalitionId }} label={messages.coalitions.homeEyebrow} />
      <PageHeader title={messages.card.coalitionTitle} pageTitle={messages.card.coalitionTitle} />
      <p className="lede">{line}</p>
    </main>
  );
}

/** Shown when this device may read no room of the coalition's: it is in none of its member groups (#125). */
function RoomMissing({
  coalitionId,
  name,
}: {
  readonly coalitionId: string;
  readonly name: string;
}) {
  const { room } = messages;
  return (
    <main className="shell">
      <BackLink to={{ name: 'coalition', coalitionId }} label={name} />
      <PageHeader eyebrow={room.eyebrow} title={room.missingTitle} pageTitle={room.pageTitle} />
      <p className="lede">{room.missing}</p>
    </main>
  );
}

interface RoomReadyProps {
  readonly services: AppServices;
  readonly ready: Ready;
  readonly deviceNow: number;
}

/** The room once the coalition and groups are read: its entry, read as the store changes. */
function RoomReady({ services, ready, deviceNow }: RoomReadyProps) {
  const { held, groups } = ready;
  const { sync } = services;
  const subscribe = useCallback((heard: () => void) => sync.subscribe(heard), [sync]);
  const reachable = useSyncExternalStore(subscribe, () => sync.isReachable());
  const roomId = roomEntryFor(held.state, groups.map(holderOf));
  const { group: room, loaded } = useStoredGroup(services.store, roomId ?? '');
  // Folding the room checks each message's signature: only again once something it reads changed.
  const view = useMemo(() => roomView(held, groups, room), [held, groups, room]);
  if (!loaded) return null;
  if (view === null) {
    return <RoomMissing coalitionId={held.state.group ?? ''} name={held.state.name} />;
  }
  return (
    <CoalitionRoom
      view={view}
      now={relayMinuteNow(room ?? held.entry, deviceNow)}
      reachable={reachable}
      onSend={(text) => sendMessage(services, view.coalitionId, view.roomId, text)}
      onTakePart={(name) => ready.onTakePart(takePartGroup(ready), name)}
    />
  );
}

/** The coalition's room (#125). */
function RoomScreen({ services, coalitionId }: Omit<GateProps, 'children'>) {
  const deviceNow = useNow(services.now);
  return (
    <CoalitionGate services={services} coalitionId={coalitionId}>
      {(ready) => <RoomReady services={services} ready={ready} deviceNow={deviceNow} />}
    </CoalitionGate>
  );
}

/** The screen for a route inside one coalition (#120). */
export function CoalitionRouteScreen({
  route,
  services,
}: {
  readonly route: CoalitionRoute;
  readonly services: AppServices;
}) {
  const { coalitionId } = route;
  switch (route.name) {
    case 'coalition':
      return <HomeScreen services={services} coalitionId={coalitionId} />;
    case 'coalitionDocument':
      return (
        <DocumentScreen
          services={services}
          coalitionId={coalitionId}
          documentId={route.documentId}
        />
      );
    case 'coalitionPropose':
      return <ProposeScreen services={services} coalitionId={coalitionId} atomId={route.atomId} />;
    case 'coalitionReconcile':
      return <ReconcileScreen services={services} coalitionId={coalitionId} />;
    case 'coalitionLog':
      return (
        <LogScreen services={services} coalitionId={coalitionId} documentId={route.documentId} />
      );
    case 'coalitionRoom':
      return <RoomScreen services={services} coalitionId={coalitionId} />;
  }
}

/** Props for {@link FollowScreen}. */
export interface FollowScreenProps {
  readonly services: AppServices;
  /** The seed as written after `#follow/`, or null once it has left the address bar. */
  readonly payload: string | null;
  /** The seed of a follow link pasted on Start, held in memory. */
  readonly heldSeed: Uint8Array | null;
  /** Lets go of the seed held in memory, once Follow or Not now is done with it. */
  readonly releaseSeed: () => void;
}

/**
 * Follow a coalition (#124): the link's preview, then Follow, which keeps
 * the coalition on this device and opens its home in place of this screen.
 */
export function FollowScreen({ services, payload, heldSeed, releaseSeed }: FollowScreenProps) {
  const lookup = useCallback((seed: Uint8Array) => lookupFollow(services, seed), [services]);
  const onFollow = useCallback(
    async (found: FoundFollow) => {
      const coalitionId = await followCoalition(services, found);
      releaseSeed();
      replaceRoute({ name: 'coalition', coalitionId });
      return true;
    },
    [services, releaseSeed],
  );
  const onNotNow = useCallback(() => {
    releaseSeed();
    replaceRoute({ name: 'start' });
  }, [releaseSeed]);
  return (
    <Follow
      payload={payload}
      heldSeed={heldSeed}
      lookup={lookup}
      onFollow={onFollow}
      onNotNow={onNotNow}
    />
  );
}
