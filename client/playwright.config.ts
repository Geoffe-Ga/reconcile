/**
 * The end-to-end tests (#67, #71): the built app under `vite preview`, which
 * sends the deploy CSP, talking to the real relay. Run them with
 * `scripts/e2e.sh`, which picks the ports, a throwaway relay database and the
 * relay's log file. Each test starts and stops the relay itself
 * (`e2e/support/relay.ts`), so one can scan what it left behind.
 */
import { defineConfig, devices } from '@playwright/test';

import { relayFiles, required } from './e2e/support/relay';

const webPort = required('E2E_WEB_PORT');
// vite preview proxies /v1 to this port, where each test's relay listens.
required('RECONCILE_RELAY_PORT');
// Checked here so the tests never write to .relay-data/ or lose the relay's output.
relayFiles();

export default defineConfig({
  testDir: 'e2e',
  // Every test runs a whole loop against the one relay port: one at a time, no retries.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  // The sync loop polls the relay every 3 seconds (spec §7).
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${webPort} --strictPort`,
    url: `http://127.0.0.1:${webPort}/`,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
