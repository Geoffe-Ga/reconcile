/**
 * The end-to-end loop (#67): the built app under `vite preview`, which sends
 * the deploy CSP, talking to the real relay. Run it with `scripts/e2e.sh`,
 * which picks the ports and a throwaway relay database.
 */
import { defineConfig, devices } from '@playwright/test';

/** A variable `scripts/e2e.sh` sets, or a clear stop when it's missing. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Run the loop with client/scripts/e2e.sh, which sets it.`);
  }
  return value;
}

const webPort = required('E2E_WEB_PORT');
const relayPort = required('RECONCILE_RELAY_PORT');
// relay.sh reads it itself; checked here so the loop never writes to .relay-data/.
required('RECONCILE_RELAY_DB');

export default defineConfig({
  testDir: 'e2e',
  // Every test runs against one relay: one at a time, no retries.
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
  // Desktop profiles: neither is an iPhone or iPad, so the install gate stays
  // open for them; e2e/ios-gate.spec.ts opens iPhone profiles of its own.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // offline.spec.ts takes the network away from the service worker, which
    // Playwright does in Chromium (#76).
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testIgnore: 'offline.spec.ts',
    },
  ],
  webServer: [
    {
      command: '../scripts/relay.sh',
      url: `http://127.0.0.1:${relayPort}/v1/health`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `npx vite preview --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}/`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
