/**
 * The steward's pins (#488; listed-doors.md §6.2). Every other test runs
 * against the tests' own key (`test-setup.ts`); this one reads the app's.
 */
import { describe, expect, it, vi } from 'vitest';

import { canonicalBytes } from '../crypto/base64url';
import { isUsableKxKey } from '../crypto/box';
import { TEST_PINS } from '../test/steward';
import type * as Pinned from './steward';

/** Whether `text` is a 32-byte key in canonical unpadded base64url. */
const isKey = (text: string): boolean => canonicalBytes(text)?.length === 32;

describe('STEWARD_PINS', () => {
  it('is null until the founder pins two keys, and then never the tests’ key', async () => {
    const { STEWARD_PINS: pins } = await vi.importActual<typeof Pinned>('./steward');

    const pinned =
      pins !== null &&
      isKey(pins.sign) &&
      isKey(pins.box) &&
      isUsableKxKey(canonicalBytes(pins.box) ?? new Uint8Array(0)) &&
      pins.sign !== TEST_PINS.sign &&
      pins.box !== TEST_PINS.box;
    expect(pins === null || pinned).toBe(true);
  });
});
