/**
 * A coalition's own screens (#120): its home, its Document and its composer,
 * and its room (#125), on the services `main.tsx` builds, as App.tsx wires a
 * group's.
 *
 * Each reads the coalition entries and groups on this device, folded, and
 * turns what the screens report into actions on the store: taking part
 * (#114), proposing a motion, which goes to the coalition's outbox under
 * this device's key there (ADR-0009) and to the relay at once, writing in
 * the room, which goes to the room's outbox under that same key (#125), and
 * sharing a follow link, and unfollowing a coalition this device only
 * follows (#124), which posts nothing.
 */
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react';

import { seatIn } from '../engine/crossing';
import { CoalitionHome } from '../screens/CoalitionHome';
import { Follow } from '../screens/Follow';
import { CoalitionRoom } from '../screens/CoalitionRoom';
import { CoalitionComposer, type ComposeOutcome } from '../screens/Composer';
import { CoalitionDocumentView } from '../screens/DocumentView';
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
import { messages } from './messages';
import { propose, type ProposalValues } from './proposals';
import { takePart } from './reconcile';
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

/** Renders `children` once the coalition and this device's groups are read, or says it isn't here. */
function CoalitionGate({ services, coalitionId, children }: GateProps) {
  const coalitions = useCoalitionList(services.store);
  const groups = useGroups(services.store, deviceGroupOf);
  if (coalitions === null || groups === null) return null;
  const held = coalitionById(coalitions, coalitionId);
  if (held === undefined) return <CoalitionMissing />;
  const onTakePart = (groupId: string, name: string) =>
    takePart(services, held.entry.groupId, groupId, name);
  return children({ held, groups, onTakePart });
}

/** The group whose seat this device holds that Back returns to, or null for Your groups. */
function backFor(held: HeldCoalition, groups: readonly DeviceGroup[]) {
  const group = groups.find((each) => seatIn(each.state, held.state) !== null);
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
            title={document.title}
            atoms={atoms}
            standing={standingIn(ready.held, ready.groups)}
            open={open}
            onPropose={(atomId) => {
              navigate({ name: 'coalitionPropose', coalitionId, atomId });
            }}
            onTakePart={(name) => ready.onTakePart(takePartGroup(ready), name)}
            copyText={services.copyText}
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
