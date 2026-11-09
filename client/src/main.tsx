import '@fontsource-variable/newsreader';
import '@fontsource-variable/public-sans';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/pressable.css';
import './styles/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { copyToClipboard } from './app/services';
import { stubSeal } from './crypto/stubSeal';
import { createRelay } from './net/relay';
import { openStore } from './store/db';
import { createSync } from './store/sync';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Reconcile could not start: the #root element is missing from index.html.');
}

/** Opens the store, starts syncing while the page is visible, and renders the app. */
async function start(container: HTMLElement): Promise<void> {
  const store = await openStore();
  const relay = createRelay();
  const sync = createSync({ store, relay });
  sync.start();
  const services = {
    store,
    relay,
    sync,
    seal: stubSeal,
    now: () => Date.now(),
    origin: window.location.origin,
    copyText: copyToClipboard,
  };
  createRoot(container).render(
    <StrictMode>
      <App services={services} />
    </StrictMode>,
  );
}

void start(root);
