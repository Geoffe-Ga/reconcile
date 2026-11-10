/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { serviceWorker } from './plugins/serviceWorker.ts';

export default defineConfig(({ mode }) => {
  // The app calls the relay at /v1 on its own origin. In development, and in
  // `vite preview` (which reuses server.proxy), that is ./scripts/relay.sh.
  const { RECONCILE_RELAY_PORT = '8787' } = loadEnv(mode, '.', 'RECONCILE_RELAY_');

  return {
    // serviceWorker() writes /sw.js, which keeps the app offline (#76).
    plugins: [react(), serviceWorker()],
    server: {
      proxy: { '/v1': `http://127.0.0.1:${RECONCILE_RELAY_PORT}` },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      // Vitest blanks stylesheets unless told otherwise. A `?raw` import of one
      // returns its text, as in a build, so a test can check what ships.
      css: { include: [/\.css\?raw$/] },
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          'src/**/*.test.{ts,tsx}',
          'src/test/**',
          'src/main.tsx',
          // The worker's entry only starts src/net/serviceWorker.ts, which is tested.
          'src/net/sw.ts',
          'src/test-setup.ts',
          'src/vite-env.d.ts',
        ],
        thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
      },
    },
    // The CSP below allows no data: URLs, so no asset (a small font subset, say)
    // may be inlined as one: every asset is a file served from 'self'.
    build: { assetsInlineLimit: 0 },
    // deploy/Caddyfile's CSP, so the e2e loop under `vite preview` runs the build
    // under the policy members get. deploy/check.sh keeps the two equal.
    preview: {
      headers: {
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  };
});
