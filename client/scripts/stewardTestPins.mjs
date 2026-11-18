#!/usr/bin/env node
/**
 * Prints the build settings that pin the tests' steward key (#505), one
 * NAME=value line each:
 *
 *   RECONCILE_STEWARD_PIN_SIGN=…
 *   RECONCILE_STEWARD_PIN_BOX=…
 *
 * They come from `TEST_PIN_SETTINGS` in src/test/steward.ts, which derives
 * them from the publicly known test secret, so this script holds no key of
 * its own. scripts/e2e.sh builds the app with them, so an e2e device honours
 * the tests' steward, and ../deploy/deploy.sh refuses any build that holds
 * either key, so they can never ship.
 *
 * Vite's module runner loads the TypeScript source. Run it from anywhere:
 *
 *   node client/scripts/stewardTestPins.mjs
 */
import { fileURLToPath } from 'node:url';

import { runnerImport } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const { module } = await runnerImport(
  fileURLToPath(new URL('../src/test/steward.ts', import.meta.url)),
  { root, configFile: false, logLevel: 'silent' },
);
for (const [name, value] of Object.entries(module.TEST_PIN_SETTINGS)) {
  console.log(`${name}=${value}`);
}
