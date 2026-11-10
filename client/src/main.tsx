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
import { botNotice } from './app/chatMessages';
import { Root } from './app/Root';
import { copyToClipboard } from './app/services';
import { browserShare } from './app/share';
import { xchachaSeal } from './crypto/seal';
import { postWebhook } from './net/discord';
import { createRelay } from './net/relay';
import { guideRecord } from './platform/guide';
import { readPlatform } from './platform/installGate';
import { noticeRecord } from './platform/notice';
import { requestPersistence } from './platform/persist';
import { createChatBot } from './store/chatBot';
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
 * The chat bot posts only for a group that turned it on by Proposal (#119).
 */
async function start(container: HTMLElement): Promise<void> {
  const store = await openStore();
  const relay = createRelay();
  const notice = botNotice(window.location.origin);
  const chatBot = createChatBot({ store, post: postWebhook, notice });
  const sync = createSync({ store, relay, seal: xchachaSeal, chatBot });
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
    guide: guideRecord(),
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
