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
      // A worker for every core. Vitest's default leaves one free, which on
      // CI's two-core runner ran every file one at a time.
      maxWorkers: '100%',
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
    // under the policy members get. deploy/check.sh keeps the two equal. Its one
    // hash is React Aria's iOS scroll-lock <style> (#153), which
    // src/styles/scrollLockStyle.test.tsx pins. It hashes public CSS, so the
    // pragma tells detect-secrets it's no secret. connect-src adds one path to
    // the relay's origin: Discord's webhooks, for the chat bot (#119), which
    // src/net/discord.test.ts pins.
    preview: {
      headers: {
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src-elem 'self' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='; connect-src 'self' https://discord.com/api/webhooks/; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", // pragma: allowlist secret
      },
    },
  };
});
