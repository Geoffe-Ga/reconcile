import '@fontsource-variable/newsreader';
import '@fontsource-variable/public-sans';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/pressable.css';
import './styles/app.css';
import './styles/proposals.css';
import './styles/firstRun.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { afterLoad, registerServiceWorker } from './app/pwa/registerServiceWorker';
import { Root } from './app/Root';
import { copyToClipboard } from './app/services';
import { browserShare } from './app/share';
import { xchachaSeal } from './crypto/seal';
import { createRelay } from './net/relay';
import { readPlatform } from './platform/installGate';
import { noticeRecord } from './platform/notice';
import { requestPersistence } from './platform/persist';
import { sweepArchives } from './store/archive';
import { openStore } from './store/db';
import { createSync } from './store/sync';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Reconcile could not start: the #root element is missing from index.html.');
}

/**
 * Opens the store, starts syncing while the page is visible, and renders the
 * app behind first run: the install gate and the pilot notice (#76). The store
 * opens empty on a new device, and nothing makes keys until first run is through.
 * Each launch first wipes, or clears the ballots of, any dissolved group
 * whose time has come by this device's clock (#108).
 */
async function start(container: HTMLElement): Promise<void> {
  const store = await openStore();
  // A sweep that fails tries again at the next launch; the app opens either way.
  await sweepArchives(store).catch(() => undefined);
  const relay = createRelay();
  const sync = createSync({ store, relay, seal: xchachaSeal });
  sync.start();
  const services = {
    store,
    relay,
    sync,
    seal: xchachaSeal,
    now: () => Date.now(),
    origin: window.location.origin,
    copyText: copyToClipboard,
    share: browserShare(),
  };
  const firstRun = { platform: readPlatform(), notice: noticeRecord(), requestPersistence };
  createRoot(container).render(
    <StrictMode>
      <Root services={services} firstRun={firstRun} />
    </StrictMode>,
  );
}

void start(root);

registerServiceWorker({
  production: import.meta.env.PROD,
  container: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
  afterLoad,
});
