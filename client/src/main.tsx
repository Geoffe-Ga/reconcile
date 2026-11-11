import '@fontsource-variable/newsreader';
import '@fontsource-variable/public-sans';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/pressable.css';
import './styles/app.css';
import './styles/proposals.css';
import './styles/firstRun.css';
import './styles/backup.css';
import './styles/link.css';
import './styles/passkey.css';
import './styles/recovery.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { afterLoad, registerServiceWorker } from './app/pwa/registerServiceWorker';
import { botNotice, botThreadName } from './app/chatMessages';
import { openDeviceLock, passkeyOn, whenOpen } from './app/passkey';
import { Root } from './app/Root';
import { afterEveryPass } from './recovery/holder';
import { parseRoute } from './app/router';
import { copyToClipboard } from './app/services';
import { browserFileTargets, browserShare } from './app/share';
import { SharedRoot } from './app/SharedRoot';
import { xchachaSeal } from './crypto/seal';
import { getWebhook, postWebhook } from './net/discord';
import { createPushRelay } from './net/push';
import { createRelay } from './net/relay';
import { guideRecord } from './platform/guide';
import { readPlatform } from './platform/installGate';
import { noticeRecord } from './platform/notice';
import { passkeyOfferRecord } from './platform/passkeyOffer';
import { requestPersistence } from './platform/persist';
import { browserPushPort, closeWhenVisible } from './platform/pushPort';
import { browserCredentials, webAuthn } from './platform/webauthn';
import { createChatBot } from './store/chatBot';
import { openStore } from './store/db';
import { eraseDevice } from './store/erase';
import { createPush } from './store/push';
import { sweepArchives } from './store/archive';
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
 * for a group that turned it on by Proposal and hasn't dissolved (#119), into
 * a thread per Proposal when its webhook is a forum channel's (#123). Push
 * stays off until the person turns a group on in Settings (#99), and the app
 * closes its notifications whenever it comes to the front. After each
 * complete sync pass, once its key changes and push upkeep are done, the
 * relay backup refreshes once a relay day, once the device keeps a backup
 * key (#97), and any backup id an earlier choice of recovery contacts
 * retired is overwritten (#109); before both, any recovery share this device
 * holds for someone else goes, or stops, once its 72 hours are up (#118). Each launch also posts again any shared personal Document whose
 * link is due a fresh copy or has an edit waiting (#105). That runs beside the
 * sync loop, not in its pass: a share has its own mailbox and keys, so no
 * group's key change or freeze touches it. A device whose keys are locked
 * with a passkey (#95) sweeps, syncs, and so refreshes the relay backup, and
 * posts shares only once the passkey unlocks them (`openDeviceLock`); the
 * relying party is this host.
 */
async function start(container: HTMLElement): Promise<void> {
  const store = await openStore();
  const relay = createRelay();
  const notice = botNotice(window.location.origin);
  const chatBot = createChatBot({
    store,
    post: postWebhook,
    getWebhook,
    notice,
    threadName: botThreadName,
  });
  const port = browserPushPort();
  const push = createPush({ store, relay: createPushRelay(), port });
  const now = (): number => Date.now();
  const afterPass = (): Promise<void> => afterEveryPass({ store, relay, seal: xchachaSeal, now });
  const sync = createSync({ store, relay, seal: xchachaSeal, chatBot, push, afterPass });
  closeWhenVisible(port, document);
  const platform = readPlatform();
  const credentials = browserCredentials();
  const webauthn = credentials === undefined ? undefined : webAuthn(credentials);
  const keys = { store, webauthn, platform, rpId: window.location.hostname };
  const shares = () => keepSharesAlive({ store, relay, seal: xchachaSeal, now });
  // The archive sweep, the sync loop and the shares: at once, or once the passkey unlocks the keys.
  const lock = await openDeviceLock({
    ...keys,
    open: whenOpen(store, sync, sweepArchives, shares),
  });
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
    push,
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
