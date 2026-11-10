import '@fontsource-variable/newsreader';
import '@fontsource-variable/public-sans';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/pressable.css';
import './styles/app.css';
import './styles/proposals.css';
import './styles/firstRun.css';
import './styles/backup.css';
import './styles/passkey.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { afterLoad, registerServiceWorker } from './app/pwa/registerServiceWorker';
import { botNotice } from './app/chatMessages';
import { openDeviceLock, passkeyOn, whenOpen } from './app/passkey';
import { Root } from './app/Root';
import { copyToClipboard } from './app/services';
import { browserFileTargets, browserShare } from './app/share';
import { xchachaSeal } from './crypto/seal';
import { postWebhook } from './net/discord';
import { createRelay } from './net/relay';
import { guideRecord } from './platform/guide';
import { readPlatform } from './platform/installGate';
import { noticeRecord } from './platform/notice';
import { passkeyOfferRecord } from './platform/passkeyOffer';
import { requestPersistence } from './platform/persist';
import { browserCredentials, webAuthn } from './platform/webauthn';
import { createChatBot } from './store/chatBot';
import { openStore } from './store/db';
import { eraseDevice } from './store/erase';
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
 * whose time has come by this device's clock (#108). The chat bot posts only
 * for a group that turned it on by Proposal and hasn't dissolved (#119). A
 * device whose keys are locked with a passkey (#95) sweeps and syncs only
 * once the passkey unlocks them (`openDeviceLock`); the relying party is this
 * host.
 */
async function start(container: HTMLElement): Promise<void> {
  const store = await openStore();
  const relay = createRelay();
  const notice = botNotice(window.location.origin);
  const chatBot = createChatBot({ store, post: postWebhook, notice });
  const sync = createSync({ store, relay, seal: xchachaSeal, chatBot });
  const platform = readPlatform();
  const credentials = browserCredentials();
  const webauthn = credentials === undefined ? undefined : webAuthn(credentials);
  const keys = { store, webauthn, platform, rpId: window.location.hostname };
  // The archive sweep, then the sync loop: at once, or once the passkey unlocks the keys.
  const lock = await openDeviceLock({ ...keys, open: whenOpen(store, sync) });
  const services = {
    store,
    relay,
    sync,
    seal: xchachaSeal,
    now: () => Date.now(),
    origin: window.location.origin,
    copyText: copyToClipboard,
    share: browserShare(),
    files: browserFileTargets(),
    erase: () => eraseDevice({ sync, store }),
    guide: guideRecord(),
    passkey: passkeyOn(keys),
  };
  const firstRun = {
    platform,
    notice: noticeRecord(),
    requestPersistence,
    lock,
    passkeyOffer: passkeyOfferRecord(),
  };
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
