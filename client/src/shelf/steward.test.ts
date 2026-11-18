/**
 * The steward's pins (#488, #505; listed-doors.md §6.2). Every other test
 * runs against the tests' own key (`test-setup.ts`); this one reads the
 * app's, which the build defines from its settings (`plugins/stewardPins.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEST_PINS, TEST_PIN_SETTINGS } from '../test/steward';
import type * as Pinned from './steward';

/** The app's own `steward.ts`, read afresh. */
async function actualPins(): Promise<Pinned.StewardPins | null> {
  vi.resetModules();
  const { STEWARD_PINS } = await vi.importActual<typeof Pinned>('./steward');
  return STEWARD_PINS;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('STEWARD_PINS', () => {
  it('is null when the build sets no pins, as this test run does', async () => {
    expect(await actualPins()).toBeNull();
  });

  it('is the tests’ pins under the settings the e2e build uses (#505)', () => {
    expect(TEST_PIN_SETTINGS).toEqual({
      RECONCILE_STEWARD_PIN_SIGN: TEST_PINS.sign,
      RECONCILE_STEWARD_PIN_BOX: TEST_PINS.box,
    });
  });

  it('is what the build defines', async () => {
    vi.stubGlobal('__RECONCILE_STEWARD_PINS__', TEST_PINS);

    expect(await actualPins()).toEqual(TEST_PINS);
  });
});
