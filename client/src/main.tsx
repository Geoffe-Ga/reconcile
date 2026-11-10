import '@fontsource-variable/newsreader';
import '@fontsource-variable/public-sans';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/pressable.css';
import './styles/app.css';
import './styles/proposals.css';
import './styles/firstRun.css';
import './styles/backup.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { afterLoad, registerServiceWorker } from './app/pwa/registerServiceWorker';
import { botNotice } from './app/chatMessages';
import { Root } from './app/Root';
import { parseRoute } from './app/router';
import { copyToClipboard } from './app/services';
import { browserFileTargets, browserShare } from './app/share';
import { SharedRoot } from './app/SharedRoot';
import { xchachaSeal } from './crypto/seal';
import { postWebhook } from './net/discord';
import { createRelay } from './net/relay';
import { guideRecord } from './platform/guide';
import { readPlatform } from './platform/installGate';
import { noticeRecord } from './platform/notice';
import { requestPersistence } from './platform/persist';
import { sweepArchives } from './store/archive';
import { createChatBot } from './store/chatBot';
import { openStore } from './store/db';
import { eraseDevice } from './store/erase';
import { createSync } from './store/sync';
import { keepSharesAlive } from './share/shareLink';

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
 * for a group that turned it on by Proposal and hasn't dissolved (#119).
 * Each launch also posts again any shared personal Document whose link is
 * due a fresh copy or has an edit waiting (#105).
 */
async function start(container: HTMLElement): Promise<void> {
  const store = await openStore();
  // A sweep that fails tries again at the next launch; the app opens either way.
  await sweepArchives(store).catch(() => undefined);
  const relay = createRelay();
  const notice = botNotice(window.location.origin);
  const chatBot = createChatBot({ store, post: postWebhook, notice });
  const sync = createSync({ store, relay, seal: xchachaSeal, chatBot });
  sync.start();
  const now = () => Date.now();
  // A share whose post fails stays pending, and the next launch tries again.
  void keepSharesAlive({ store, relay, seal: xchachaSeal, now }).catch(() => undefined);
  const services = {
    store,
    relay,
    sync,
    seal: xchachaSeal,
    now,
    origin: window.location.origin,
    copyText: copyToClipboard,
    share: browserShare(),
    files: browserFileTargets(),
    erase: () => eraseDevice({ sync, store }),
    guide: guideRecord(),
  };
  const firstRun = { platform: readPlatform(), notice: noticeRecord(), requestPersistence };
  createRoot(container).render(
    <StrictMode>
      <Root services={services} firstRun={firstRun} />
    </StrictMode>,
  );
}

/**
 * A share link opened fresh (#105) gets its page alone: no store, sync, keys
 * or service worker, so a reader's browser keeps nothing of Reconcile's.
 */
function startShared(container: HTMLElement): void {
  const reader = { relay: createRelay(), seal: xchachaSeal };
  const reload = () => {
    window.location.reload();
  };
  createRoot(container).render(
    <StrictMode>
      <SharedRoot reader={reader} reload={reload} />
    </StrictMode>,
  );
}

if (parseRoute(window.location.hash).name === 'shared') {
  startShared(root);
} else {
  void start(root);
  registerServiceWorker({
    production: import.meta.env.PROD,
    container: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    afterLoad,
  });
}
