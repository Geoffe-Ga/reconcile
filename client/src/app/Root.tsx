/**
 * The whole app as `main.tsx` renders it: first run (the install gate, the
 * pilot notice, the unlock screen and the passkey offer), then the app, on
 * the services `main.tsx` builds.
 */
import { useCallback } from 'react';

import { lookupInvite } from './actions';
import { App } from './App';
import { FirstRunGate, type FirstRunServices } from './FirstRunGate';
import type { AppServices } from './services';

/** Props for {@link Root}. */
export interface RootProps {
  /** The store, sync loop, relay and the rest. */
  readonly services: AppServices;
  /** The platform, the notice record, persistence, the lock and the offer's record, for first run. */
  readonly firstRun: FirstRunServices;
}

/** First run, then the app with whatever invite first run held. */
export function Root({ services, firstRun }: RootProps) {
  const lookup = useCallback((seed: Uint8Array) => lookupInvite(services, seed), [services]);
  return (
    <FirstRunGate
      {...firstRun}
      origin={services.origin}
      copyText={services.copyText}
      lookup={lookup}
      passkey={services.passkey}
      onErase={services.erase}
    >
      {({ heldSeed, persistence }) => (
        <App services={services} initialSeed={heldSeed} persistence={persistence} />
      )}
    </FirstRunGate>
  );
}
