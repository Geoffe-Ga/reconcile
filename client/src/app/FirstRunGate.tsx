/**
 * First run (spec §8.1, #76): what stands between a new device and its keys.
 *
 * 0. **The landing page** (ADR-0078). A plain visit in a browser tab, on a
 *    device that hasn't accepted the notice, starts on the landing page. It
 *    stores nothing, and its Start a Group button moves on to the steps below.
 *    An invite link, a shelf entry's link (#431), the installed app and a
 *    returning device all skip it.
 * 1. **The install gate** (ADR-0029). An iPhone or iPad outside the installed
 *    app sees only the install guide, in every browser. Nothing there creates
 *    keys or stores anything.
 * 2. **The pilot notice** (ADR-0056). Everywhere else, the notice comes first
 *    until this device has accepted it.
 * 3. **The unlock screen** (#95). A device whose keys are locked with a
 *    passkey opens nothing, syncs nothing and signs nothing until the
 *    passkey unlocks them (`passkey.ts`).
 * 4. **The passkey offer** (#95), once, where a passkey can lock the keys
 *    and this device hasn't answered it yet: right after the notice on a new
 *    device, and at the next launch on one that accepted the notice before.
 *    It locks nothing until the groups have a way back (#389): on a device
 *    with no group yet it closes at once without an answer, and so does
 *    choosing recovery contacts from it, so it comes back at a later launch.
 * 5. **The app**, with any invite, card or follow link still in hand.
 *
 * It wraps the whole app, so every later screen sits behind it. An invite, a
 * reconcile card's or a follow link opened while any step shows leaves the
 * address bar at once and waits in memory (spec §9: secrets stay after `#`,
 * and not even there for long; `heldLinks.ts`, #280). The install guide
 * offers it to copy into the installed app, which on iOS keeps storage of
 * its own and opens at its start, so nothing else could carry it there.
 * Once the notice is accepted, at that moment and at each launch after, the
 * app asks the browser to keep its data (ADR-0029).
 */
import { type ReactNode, useEffect, useState } from 'react';

import type { DoorView } from '../door/page';
import { canCreateKeys, isInstalled, type PlatformEnv } from '../platform/installGate';
import type { NoticeRecord } from '../platform/notice';
import type { PasskeyOfferRecord } from '../platform/passkeyOffer';
import type { Persistence } from '../platform/persist';
import { type Arrival, InstallGuide } from '../screens/InstallGuide';
import { Landing } from '../screens/Landing';
import { PasskeyOffer } from '../screens/PasskeyOffer';
import { PilotNotice } from '../screens/PilotNotice';
import { UnlockScreen } from '../screens/UnlockScreen';
import type { InviteLookup } from './actions';
import { HELD_LINKS, heldLinkOf, heldRoute } from './heldLinks';
import type { DeviceLock, Passkey } from './passkey';
import type { SaveBackupProps } from './SaveBackup';
import { parseRoute, replaceRoute } from './router';

/** What first run reads and records on this device, built once by `main.tsx`. */
export interface FirstRunServices {
  /** What the browser reports, for the install gate. */
  readonly platform: PlatformEnv;
  /** Whether this device accepted the pilot notice. */
  readonly notice: NoticeRecord;
  /** Asks the browser to keep the app's data. Never throws. */
  readonly requestPersistence: () => Promise<Persistence>;
  /** Whether this device's keys are locked with a passkey, and the way to unlock them (#95). */
  readonly lock: DeviceLock;
  /** Whether this device answered the passkey offer (#95). */
  readonly passkeyOffer: PasskeyOfferRecord;
}

/** What the app opens with. */
export interface OpenedApp {
  /**
   * The seed of an invite, card or follow link first run took out of the
   * address bar, for the page the address bar now names (#280).
   */
  readonly heldSeed: Uint8Array | null;
  /** What the browser said about keeping the data, or null until it answers. */
  readonly persistence: Persistence | null;
}

/** Props for {@link FirstRunGate}. */
export interface FirstRunGateProps extends FirstRunServices {
  /** The app's origin, for the guide's links. */
  readonly origin: string;
  /** Puts text on the clipboard, for the guide's Copy. */
  readonly copyText: (text: string) => Promise<void>;
  /** Opens an invite's envelope, for the guide's preview (#73's `lookupInvite`). */
  readonly lookup: (seed: Uint8Array) => Promise<InviteLookup>;
  /** Reads a front door's page, for the guide (#121's `readDoor`). */
  readonly readDoor: (address: Uint8Array) => Promise<DoorView>;
  /** Passkey setup, for the offer (#95). */
  readonly passkey: Passkey;
  /** Save a backup's making and saving, for the offer's way back (#389). */
  readonly backup: Pick<SaveBackupProps, 'onMake' | 'onSave'>;
  /** Erases all of Reconcile's data on this device, for the unlock screen (#95). */
  readonly onErase: () => Promise<void>;
  /** The app, once first run is through. */
  readonly children: (opened: OpenedApp) => ReactNode;
}

/**
 * How the page was opened, read from its `#door/{address}` or `#vote/{token}`
 * route (#472) or a held link's: `#join/{seed}`, `#reconcile/{seed}` or `#follow/{seed}` (#280).
 */
function arrivalFrom(hash: string): Arrival {
  const route = parseRoute(hash);
  if (route.name === 'door') return { kind: 'door', payload: route.payload };
  if (route.name === 'vote') return { kind: 'vote', payload: route.payload };
  const link = heldLinkOf(route);
  const payload = 'payload' in route ? route.payload : null;
  if (link === null || payload === null) return { kind: 'plain' };
  const seed = HELD_LINKS[link].read(payload);
  return seed === null ? { kind: 'damaged', link } : { kind: link, seed };
}

/** What first run holds: how the page was opened, and a count that moves with each new link. */
interface Held {
  readonly arrival: Arrival;
  readonly visit: number;
}

/**
 * Takes a held link's secret out of the address bar. The guide clears the
 * whole address, since this browser never opens the app; under the notice,
 * the link's own page stays (Join, Bring a card or Follow), so the app opens
 * there with the seed in hand. A front door's link holds no secret (#121),
 * so it stays, and the app opens at the door once the notice is accepted;
 * so does a vote link (#472), whose token names no group.
 */
function release(arrival: Arrival, open: boolean): void {
  if (arrival.kind === 'door' || arrival.kind === 'vote') return;
  if (!open) window.history.replaceState(null, '', '/');
  else if (arrival.kind === 'damaged') replaceRoute(heldRoute(arrival.link));
  else if (arrival.kind !== 'plain') replaceRoute(heldRoute(arrival.kind));
}

/**
 * The link first run holds while it shows the guide or the notice: the one
 * the page opened with, or a newer one opened in the same window, as an
 * in-app browser may do. Each leaves the address bar as soon as it's read.
 */
function useHeldArrival(holding: boolean, open: boolean): Held {
  const [held, setHeld] = useState<Held>(() => ({
    arrival: arrivalFrom(window.location.hash),
    visit: 0,
  }));
  useEffect(() => {
    if (holding) release(held.arrival, open);
  }, [holding, open, held]);
  useEffect(() => {
    if (!holding) return;
    const read = () => {
      const arrival = arrivalFrom(window.location.hash);
      setHeld((current) => ({
        arrival: arrival.kind === 'plain' ? current.arrival : arrival,
        visit: current.visit + 1,
      }));
    };
    window.addEventListener('hashchange', read);
    return () => {
      window.removeEventListener('hashchange', read);
    };
  }, [holding]);
  return held;
}

/** Asks to keep the data once the notice is accepted, and at each launch after. */
function usePersistence(
  ready: boolean,
  requestPersistence: FirstRunServices['requestPersistence'],
): Persistence | null {
  const [persistence, setPersistence] = useState<Persistence | null>(null);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void requestPersistence().then((answer) => {
      if (live) setPersistence(answer);
    });
    return () => {
      live = false;
    };
  }, [ready, requestPersistence]);
  return persistence;
}

/** Which first-run step shows. */
type Step = 'install' | 'notice' | 'unlock' | 'offer' | 'app';

/** What decides the step: the install gate, the notice, the lock and the offer. */
interface StepInputs {
  readonly open: boolean;
  readonly accepted: boolean;
  readonly locked: boolean;
  readonly offering: boolean;
}

/** The step for `inputs`, in first run's order. */
function stepOf({ open, accepted, locked, offering }: StepInputs): Step {
  if (!open) return 'install';
  if (!accepted) return 'notice';
  if (locked) return 'unlock';
  return offering ? 'offer' : 'app';
}

/** The notice, the lock and the offer, as they stand at launch and as each is answered. */
function useSteps(props: FirstRunGateProps, open: boolean) {
  const { notice, lock, passkey, passkeyOffer } = props;
  const [accepted, setAccepted] = useState(() => notice.accepted());
  const [locked, setLocked] = useState(lock.lockedAtLaunch);
  const [offering, setOffering] = useState(
    () => passkey.available && !lock.lockedAtLaunch && !passkeyOffer.answered(),
  );
  const step = stepOf({ open, accepted, locked, offering });
  const [gatedAtLaunch] = useState(step !== 'app');
  return {
    step,
    accepted,
    gatedAtLaunch,
    accept: () => {
      notice.accept();
      setAccepted(true);
    },
    unlock: async () => {
      const opened = await lock.unlock();
      if (opened) setLocked(false);
      return opened;
    },
    restore: async (file: Uint8Array, passphrase: string) => {
      const restored = await lock.restore(file, passphrase);
      setLocked(false);
      return restored;
    },
    answerOffer: () => {
      passkeyOffer.answer();
      setOffering(false);
    },
    skipOffer: () => {
      setOffering(false);
    },
  };
}

/**
 * Whether the landing page shows (ADR-0078): on a plain visit in a browser
 * tab, until its Start a Group is pressed. That is kept only in memory,
 * because the landing page stores nothing, so each new visit starts on it
 * again.
 */
function useWelcome(
  { notice, platform, lock }: FirstRunGateProps,
  arrival: Arrival,
): { readonly showing: boolean; readonly start: () => void } {
  // A plain visit in a browser tab, on a device that hadn't accepted the notice at launch
  // and holds no locked keys: a device with keys isn't new, whatever its notice says.
  const [newHere] = useState(() => !notice.accepted() && !lock.lockedAtLaunch);
  // Where keys can be made, a vote link goes as a plain visit (#472): its screen says, once
  // first run is through, that the vote opens only on a device in its group. Behind the
  // install gate, the guide holds the link to copy at once, as it holds an invite's.
  const plain = arrival.kind === 'plain' || (arrival.kind === 'vote' && canCreateKeys(platform));
  // A shelf entry's link (#431) opens to read one entry, past the notice: it skips the landing page.
  const [entryLink] = useState(() => parseRoute(window.location.hash).name === 'shelfEntry');
  const visiting = newHere && !isInstalled(platform) && plain && !entryLink;
  const [welcomed, setWelcomed] = useState(false);
  const start = () => {
    // The next screen opens at its top, wherever on the page Start a Group was pressed.
    document.documentElement.scrollTop = 0;
    setWelcomed(true);
  };
  return { showing: visiting && !welcomed, start };
}

/**
 * Shows a new visitor the landing page, then the install guide, the pilot
 * notice, the unlock screen or the passkey offer, then the app.
 */
export function FirstRunGate(props: FirstRunGateProps) {
  const { platform, requestPersistence, origin, copyText, lookup, readDoor, children } = props;
  const open = canCreateKeys(platform);
  const steps = useSteps(props, open);
  const { step } = steps;
  // Once nothing stood in the way at launch, Join reads any link itself, as it always has.
  const { arrival, visit } = useHeldArrival(step !== 'app', open);
  const persistence = usePersistence(open && steps.accepted, requestPersistence);
  const welcome = useWelcome(props, arrival);
  if (welcome.showing) return <Landing onStart={welcome.start} />;

  switch (step) {
    case 'install':
      return (
        <InstallGuide
          key={visit}
          arrival={arrival}
          origin={origin}
          lookup={lookup}
          copyText={copyText}
          readDoor={readDoor}
        />
      );
    case 'notice':
      return <PilotNotice onAccept={steps.accept} />;
    case 'unlock':
      return (
        <UnlockScreen onUnlock={steps.unlock} onRestore={steps.restore} onErase={props.onErase} />
      );
    case 'offer':
      return (
        <PasskeyOffer
          passkey={props.passkey}
          backup={props.backup}
          onDone={steps.answerOffer}
          onSkip={steps.skipOffer}
        />
      );
    case 'app': {
      const heldSeed = steps.gatedAtLaunch && 'seed' in arrival ? arrival.seed : null;
      return children({ heldSeed, persistence });
    }
  }
}
