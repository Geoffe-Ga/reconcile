/**
 * The whole app as `main.tsx` renders it: first run (the install gate and
 * the pilot notice), then the app, on the services `main.tsx` builds. A
 * share link (#105) opens its page instead, outside first run, so anyone
 * can read it in any browser without a notice, an install or a key.
 */
import { useCallback } from 'react';

import { SharedPage } from '../screens/SharedPage';
import { lookupInvite } from './actions';
import { App } from './App';
import { FirstRunGate, type FirstRunServices } from './FirstRunGate';
import { useRoute } from './router';
import type { AppServices } from './services';

/** Props for {@link Root}. */
export interface RootProps {
  /** The store, sync loop, relay and the rest. */
  readonly services: AppServices;
  /** The platform, the notice record and persistence, for first run. */
  readonly firstRun: FirstRunServices;
}

/** First run, then the app with whatever invite first run held; or a share link's page. */
export function Root({ services, firstRun }: RootProps) {
  const route = useRoute();
  const lookup = useCallback((seed: Uint8Array) => lookupInvite(services, seed), [services]);
  if (route.name === 'shared') return <SharedPage payload={route.payload} reader={services} />;
  return (
    <FirstRunGate
      {...firstRun}
      origin={services.origin}
      copyText={services.copyText}
      lookup={lookup}
    >
      {({ heldSeed, persistence }) => (
        <App services={services} initialSeed={heldSeed} persistence={persistence} />
      )}
    </FirstRunGate>
  );
}
