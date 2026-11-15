/**
 * First run (spec §8.1, #76): what stands between a new device and its keys.
 *
 * 0. **The landing page** (ADR-0077). A plain visit in a browser tab, on a
 *    device that hasn't accepted the notice, starts on the landing page. It
 *    stores nothing, and its Start a Group button moves on to the steps below.
 *    An invite link, the installed app and a returning device all skip it.
 * 1. **The install gate** (ADR-0029). An iPhone or iPad outside the installed
 *    app sees only the install guide, in every browser. Nothing there creates
 *    keys or stores anything.
 * 2. **The pilot notice** (ADR-0056). Everywhere else, the notice comes first
 *    until this device has accepted it.
 * 3. **The app**, with any invite link still in hand.
 *
 * It wraps the whole app, so every later screen sits behind it. An invite
 * link the gate or the notice holds leaves the address bar at once and waits
 * in memory (spec §9: secrets stay after `#`, and not even there for long).
 * Once the notice is accepted, at that moment and at each launch after, the
 * app asks the browser to keep its data (ADR-0029).
 */
import { type ReactNode, useEffect, useState } from 'react';

import { canCreateKeys, isInstalled, type PlatformEnv } from '../platform/installGate';
import type { NoticeRecord } from '../platform/notice';
import type { Persistence } from '../platform/persist';
import { type Arrival, InstallGuide } from '../screens/InstallGuide';
import { Landing } from '../screens/Landing';
import { PilotNotice } from '../screens/PilotNotice';
import type { InviteLookup } from './actions';
import { parseInvitePayload } from './invite';
import { parseRoute, replaceRoute } from './router';

/** What first run reads and records on this device, built once by `main.tsx`. */
export interface FirstRunServices {
  /** What the browser reports, for the install gate. */
  readonly platform: PlatformEnv;
  /** Whether this device accepted the pilot notice. */
  readonly notice: NoticeRecord;
  /** Asks the browser to keep the app's data. Never throws. */
  readonly requestPersistence: () => Promise<Persistence>;
}

/** What the app opens with. */
export interface OpenedApp {
  /** The seed of an invite link first run took out of the address bar, for Join. */
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
  /** The app, once first run is through. */
  readonly children: (opened: OpenedApp) => ReactNode;
}

/** How the page was opened, read from its `#join/{seed}` route. */
function arrivalFrom(hash: string): Arrival {
  const route = parseRoute(hash);
  if (route.name !== 'join' || route.payload === null) return { kind: 'plain' };
  const seed = parseInvitePayload(route.payload);
  return seed === null ? { kind: 'damaged' } : { kind: 'invite', seed };
}

/** What first run holds: how the page was opened, and a count that moves with each new link. */
interface Held {
  readonly arrival: Arrival;
  readonly visit: number;
}

/**
 * Takes an invite's secret out of the address bar. The guide clears the
 * whole address, since this browser never opens the app; under the notice,
 * Join's route stays, so the app opens there with the invite in hand.
 */
function release(arrival: Arrival, open: boolean): void {
  if (!open) window.history.replaceState(null, '', '/');
  else if (arrival.kind !== 'plain') replaceRoute({ name: 'join', payload: null });
}

/**
 * The invite first run holds while it shows the guide or the notice: the one
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

/**
 * Whether the landing page shows (ADR-0077): on a `visiting` device, until
 * its Start a Group is pressed. That is kept only in memory, because the
 * landing page stores nothing, so each new visit starts on it again.
 */
function useWelcome(visiting: boolean): { readonly showing: boolean; readonly start: () => void } {
  const [welcomed, setWelcomed] = useState(false);
  const start = () => {
    // The next screen opens at its top, wherever on the page Start a Group was pressed.
    document.documentElement.scrollTop = 0;
    setWelcomed(true);
  };
  return { showing: visiting && !welcomed, start };
}

/** Shows a new visitor the landing page, then the install guide, the pilot notice, and the app. */
export function FirstRunGate(props: FirstRunGateProps) {
  const { platform, notice, requestPersistence, origin, copyText, lookup, children } = props;
  const open = canCreateKeys(platform);
  const [acceptedAtLaunch] = useState(() => notice.accepted());
  const [accepted, setAccepted] = useState(acceptedAtLaunch);
  // Once the notice was accepted at launch, Join reads any link itself, as it always has.
  const { arrival, visit } = useHeldArrival(!open || !accepted, open);
  const persistence = usePersistence(open && accepted, requestPersistence);
  const welcome = useWelcome(
    !acceptedAtLaunch && !isInstalled(platform) && arrival.kind === 'plain',
  );
  if (welcome.showing) return <Landing onStart={welcome.start} />;
  if (!open) {
    return (
      <InstallGuide
        key={visit}
        arrival={arrival}
        origin={origin}
        lookup={lookup}
        copyText={copyText}
      />
    );
  }
  if (!accepted) {
    const accept = () => {
      notice.accept();
      setAccepted(true);
    };
    return <PilotNotice onAccept={accept} />;
  }
  const heldSeed = !acceptedAtLaunch && arrival.kind === 'invite' ? arrival.seed : null;
  return children({ heldSeed, persistence });
}
