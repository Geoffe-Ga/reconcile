/**
 * One device's `AppServices` for tests: its own IndexedDB database on the
 * shared fake-indexeddb, and a relay client on a shared fake relay.
 */
import { vi } from 'vitest';

import type { AppServices } from '../app/services';
import { xchachaSeal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import { openStore } from '../store/db';
import { createSync } from '../store/sync';
import type { FakeRelay } from './fakeRelay';

/** The app's origin in tests. */
export const TEST_ORIGIN = 'https://reconcile.test';

/** A test device: its services, and every text it copied. */
export interface TestDevice {
  readonly services: AppServices;
  readonly copied: string[];
}

/** Opens device `name` on `fake`. The sync loop never polls; actions run it once. */
export async function testDevice(fake: FakeRelay, name: string): Promise<TestDevice> {
  const store = await openStore(name);
  const relay = createRelay({ fetch: fake.fetch });
  const now = (): number => 1_762_650_000_000;
  const sync = createSync({ store, relay, seal: xchachaSeal, clock: now });
  const copied: string[] = [];
  const copyText = vi.fn((text: string) => {
    copied.push(text);
    return Promise.resolve();
  });
  const services = { store, relay, sync, seal: xchachaSeal, now, origin: TEST_ORIGIN, copyText };
  return { services, copied };
}
