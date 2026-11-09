import '@fontsource-variable/newsreader';
import '@fontsource-variable/public-sans';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/pressable.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Reconcile could not start: the #root element is missing from index.html.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
