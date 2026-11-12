/**
 * The end-to-end tests (#67, #71): the built app under `vite preview`, which
 * sends the deploy CSP, talking to the real relay. Run them with
 * `scripts/e2e.sh`, which picks each worker's ports, and a throwaway
 * directory for each worker's relay database and log file. Each test starts
 * and stops its worker's relay itself (`e2e/support/relay.ts`), so one can
 * scan what it left behind.
 */
import { defineConfig, devices } from '@playwright/test';

import { workerServers } from './e2e/support/relay';

// Checked here so the tests never write to .relay-data/ or lose a relay's output.
const servers = workerServers();

export default defineConfig({
  testDir: 'e2e',
  // A worker for each pair of servers scripts/e2e.sh chose. Every test runs a
  // whole loop against its worker's relay port, so each worker runs its tests
  // one at a time, and none touches another's servers or files. No retries.
  workers: servers.length,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  // The sync loop polls the relay every 3 seconds (spec §7).
  expect: { timeout: 15_000 },
  reporter: 'list',
  // baseURL is each worker's own `vite preview` (e2e/support/fixtures.ts).
  use: {
    trace: 'retain-on-failure',
  },
  // Desktop profiles: neither is an iPhone or iPad, so the install gate stays
  // open for them; e2e/ios-gate.spec.ts opens iPhone profiles of its own.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // offline.spec.ts takes the network away from the service worker, which
    // Playwright does in Chromium (#76), and push.spec.ts delivers pushes over
    // Chromium's DevTools protocol, with no push service (#99).
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testIgnore: ['offline.spec.ts', 'push.spec.ts'],
    },
  ],
  webServer: servers.map(({ web, relay }) => ({
    command: `npx vite preview --host 127.0.0.1 --port ${web} --strictPort`,
    url: `http://127.0.0.1:${web}/`,
    // vite preview proxies /v1 to this worker's relay (vite.config.ts).
    env: { RECONCILE_RELAY_PORT: relay.port },
    reuseExistingServer: false,
    stdout: 'ignore' as const,
    stderr: 'pipe' as const,
  })),
});
