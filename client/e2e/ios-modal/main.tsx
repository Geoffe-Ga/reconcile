/// <reference types="vite/client" />
/**
 * The test-only page e2e/ios-scroll-lock.spec.ts opens (#153): a React Aria
 * Modal behind a React Aria Button, the way the first screen with a dialog
 * (#77's Leave dialog) will open one. The app has no modal yet, so this page
 * stands in for that screen. It ships nothing: only the spec builds it.
 */
import '../../src/styles/pressable.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Dialog, DialogTrigger, Heading, Modal } from 'react-aria-components';

import appHtml from '../../index.html?raw';

// The app's <head> claims React Aria's pressable <style> and pressable.css
// ships its rule (#150). This page copies that claim rather than repeating it,
// so it meets the CSP exactly as the app does.
const claim = new DOMParser()
  .parseFromString(appHtml, 'text/html')
  .getElementById('react-aria-pressable-style');
if (claim === null) {
  throw new Error('client/index.html no longer claims react-aria-pressable-style (#150).');
}
document.head.append(document.importNode(claim, true));

const root = document.getElementById('root');
if (root === null) {
  throw new Error('index.html has no #root to render into.');
}

createRoot(root).render(
  <StrictMode>
    <DialogTrigger>
      <Button>Open the dialog</Button>
      <Modal>
        <Dialog>
          <Heading slot="title">A React Aria Modal</Heading>
          <Button slot="close">Close</Button>
        </Dialog>
      </Modal>
    </DialogTrigger>
  </StrictMode>,
);
