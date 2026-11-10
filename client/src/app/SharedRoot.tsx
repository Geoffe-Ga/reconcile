/**
 * What `main.tsx` renders when a share link opens a fresh page (#105): the
 * shared page alone. A reader's browser gets no store, no sync loop, no keys
 * and no service worker: the page reads the share's mailbox and keeps
 * nothing. Once the address leaves the link, the page reloads, and the
 * whole app starts behind first run as on any other visit.
 */
import { useEffect } from 'react';

import { SharedPage } from '../screens/SharedPage';
import type { ShareReader } from '../share/shareLink';
import { useRoute } from './router';

/** Props for {@link SharedRoot}. */
export interface SharedRootProps {
  /** The relay and the seal: all the shared page reaches. */
  readonly reader: ShareReader;
  /** Starts the whole app: `location.reload()` in the browser. */
  readonly reload: () => void;
}

/** The shared page for the link in the address bar, until the address leaves it. */
export function SharedRoot({ reader, reload }: SharedRootProps) {
  const route = useRoute();
  const shared = route.name === 'shared';
  useEffect(() => {
    if (!shared) reload();
  }, [shared, reload]);
  return shared ? <SharedPage payload={route.payload} reader={reader} /> : null;
}
