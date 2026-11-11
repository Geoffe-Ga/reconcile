/**
 * A device-wide flag in the origin's own `localStorage` (#76, #91, #95): the
 * pilot notice's acceptance, the first-run guide's, and the passkey offer's
 * answer. Each is recorded only on this device and never sent anywhere, and
 * Erase (#78) clears them with the rest.
 *
 * A browser that blocks site data throws from `localStorage`; that reads as
 * unset, and setting keeps nothing, so the screen behind the flag shows again
 * at the next launch.
 */

/** Reads and sets one flag. */
export interface DeviceFlag {
  /** Whether the flag holds this version. */
  isSet(): boolean;
  /** Records the flag at this version on this device. */
  set(): void;
}

/** The flag `key` at `version` in `storage()`, which defaults to `localStorage`. */
export function deviceFlag(
  key: string,
  version: string,
  storage: () => Storage = () => window.localStorage,
): DeviceFlag {
  return {
    isSet() {
      try {
        return storage().getItem(key) === version;
      } catch {
        return false;
      }
    },
    set() {
      try {
        storage().setItem(key, version);
      } catch {
        // Nothing is kept, so whatever the flag holds back shows again at the next launch.
      }
    },
  };
}
