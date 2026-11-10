/**
 * Whether this device has accepted the pilot notice (ADR-0056, spec §8.1).
 *
 * It's a device-wide flag in the origin's own `localStorage`, recorded only
 * on this device and never sent anywhere. Erase (#78) clears it with the rest.
 * On iOS, the installed app has storage of its own, so the notice is accepted
 * there, after the install gate.
 */

/** The `localStorage` key that holds the accepted notice's version. */
export const NOTICE_KEY = 'reconcile.pilot-notice';

/** The notice's version. Raise it when the notice changes enough to ask everyone again. */
const NOTICE_VERSION = '1';

/** Reads and records the acceptance. */
export interface NoticeRecord {
  /** Whether this device accepted the current notice. */
  accepted(): boolean;
  /** Records the acceptance on this device. */
  accept(): void;
}

/**
 * The record in `storage()`, which defaults to `localStorage`. A browser that
 * blocks site data throws from either call; that reads as not accepted, and
 * the app asks again at the next launch.
 */
export function noticeRecord(storage: () => Storage = () => window.localStorage): NoticeRecord {
  return {
    accepted() {
      try {
        return storage().getItem(NOTICE_KEY) === NOTICE_VERSION;
      } catch {
        return false;
      }
    },
    accept() {
      try {
        storage().setItem(NOTICE_KEY, NOTICE_VERSION);
      } catch {
        // Nothing is kept, so the notice shows again at the next launch.
      }
    },
  };
}
