/**
 * The whole app as `main.tsx` renders it: first run (the install gate and
 * the pilot notice), then the app, on the services `main.tsx` builds.
 */
import { useCallback } from 'react';

import { lookupInvite } from './actions';
import { App } from './App';
import { FirstRunGate, type FirstRunServices } from './FirstRunGate';
import type { Invite } from './invite';
import type { AppServices } from './services';

/** Props for {@link Root}. */
export interface RootProps {
  /** The store, sync loop, relay and the rest. */
  readonly services: AppServices;
  /** The platform, the notice record and persistence, for first run. */
  readonly firstRun: FirstRunServices;
}

/** First run, then the app with whatever invite first run held. */
export function Root({ services, firstRun }: RootProps) {
  const lookup = useCallback((invite: Invite) => lookupInvite(services, invite), [services]);
  return (
    <FirstRunGate
      {...firstRun}
      origin={services.origin}
      copyText={services.copyText}
      lookup={lookup}
    >
      {({ heldInvite, persistence }) => (
        <App services={services} initialInvite={heldInvite} persistence={persistence} />
      )}
    </FirstRunGate>
  );
}
