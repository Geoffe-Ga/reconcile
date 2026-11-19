/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { modelFiles, ortWasmUrl } from './plugins/modelFiles.ts';
import { serviceWorker } from './plugins/serviceWorker.ts';
import { stewardPinsDefine } from './plugins/stewardPins.ts';

export default defineConfig(({ mode }) => {
  // The app calls the relay at /v1 on its own origin. In development, and in
  // `vite preview` (which reuses server.proxy), that is ./scripts/relay.sh.
  const { RECONCILE_RELAY_PORT = '8787' } = loadEnv(mode, '.', 'RECONCILE_RELAY_');

  return {
    // The steward's two public keys (#505): RECONCILE_STEWARD_PIN_SIGN and
    // RECONCILE_STEWARD_PIN_BOX from the build's environment, or null with
    // neither. A malformed one throws here, so the build fails.
    // deploy/deploy.sh refuses a build that pins the tests' key.
    define: stewardPinsDefine(process.env),
    // serviceWorker() writes /sw.js, which keeps the app offline (#76).
    // modelFiles() writes models/, the Bedfellows model's pinned files, which
    // the worker keeps on first use rather than at install (#476).
    plugins: [react(), modelFiles(), serviceWorker()],
    server: {
      proxy: { '/v1': `http://127.0.0.1:${RECONCILE_RELAY_PORT}` },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
      // Hands the tests ONNX Runtime Web's WebAssembly from node_modules (#476).
      globalSetup: ['./test/globalSetup.ts'],
      include: ['src/**/*.test.{ts,tsx}', 'plugins/**/*.test.ts'],
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
    // Workers the page starts, such as Bedfellows' (#475), are module workers:
    // ES chunks from the app's own origin, which the CSP's default-src 'self' allows.
    // ortWasmUrl() keeps the model runtime's WebAssembly out of assets/ (#476).
    worker: { format: 'es', plugins: () => [ortWasmUrl()] },
    // The CSP below allows no data: URLs, so no asset (a small font subset, say)
    // may be inlined as one: every asset is a file served from 'self'.
    build: { assetsInlineLimit: 0 },
    // deploy/Caddyfile's CSP, so the e2e loop under `vite preview` runs the build
    // under the policy members get. deploy/check.sh keeps the two equal. Its one
    // hash is React Aria's iOS scroll-lock <style> (#153), which
    // src/styles/scrollLockStyle.test.tsx pins. It hashes public CSS, so the
    // pragma tells detect-secrets it's no secret. connect-src adds one path to
    // the relay's origin: Discord's webhooks, for the chat bot (#119), which
    // src/net/discord.test.ts pins. script-src's 'wasm-unsafe-eval' lets the
    // Bedfellows worker compile the model runtime's WebAssembly (#476).
    preview: {
      headers: {
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src-elem 'self' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='; connect-src 'self' https://discord.com/api/webhooks/; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", // pragma: allowlist secret
      },
    },
  };
});
