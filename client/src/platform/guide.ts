/**
 * Whether this device has seen the first-run guide (#91): the three cards
 * after the first Create group or Join, shown once per device.
 *
 * It's a device-wide flag in the origin's own `localStorage`, beside the
 * pilot notice's (`notice.ts`), recorded only on this device and never sent
 * anywhere. Skip and Done set it, and Erase (#78) clears it with the rest.
 */
import { deviceFlag } from './deviceFlag';

/** The `localStorage` key that holds the seen guide's version. */
export const GUIDE_KEY = 'reconcile.first-run-guide';

/** The guide's version. Raise it when the guide changes enough to show everyone again. */
const GUIDE_VERSION = '1';

/** Reads and records whether the guide was seen. */
export interface GuideRecord {
  /** Whether this device has seen the current guide. */
  seen(): boolean;
  /** Records on this device that the guide was skipped or finished. */
  see(): void;
}

/**
 * The record in `storage()`, which defaults to `localStorage`. A browser that
 * blocks site data reads as not seen, so the guide can show again after a
 * later Create group or Join.
 */
export function guideRecord(storage?: () => Storage): GuideRecord {
  const flag = deviceFlag(GUIDE_KEY, GUIDE_VERSION, storage);
  return {
    seen: () => flag.isSet(),
    see: () => {
      flag.set();
    },
  };
}
