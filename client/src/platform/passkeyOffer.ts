/**
 * Whether this device has answered the passkey offer (#95): Reconcile offers
 * a passkey once after the pilot notice, and always in Settings.
 *
 * It's a device flag beside the pilot notice's (`deviceFlag.ts`): recorded
 * only on this device, never sent anywhere, and cleared by Erase (#78), so a
 * device that starts over is offered a passkey again.
 */
import { deviceFlag } from './deviceFlag';

/** The `localStorage` key that holds the answered offer's version. */
export const PASSKEY_OFFER_KEY = 'reconcile.passkey-offer';

/** The offer's version. Raise it to offer everyone a passkey again. */
const OFFER_VERSION = '1';

/** Reads and records whether the offer was answered. */
export interface PasskeyOfferRecord {
  /** Whether this device answered the current offer. */
  answered(): boolean;
  /** Records on this device that the offer was answered: Not now, or Continue after setup. */
  answer(): void;
}

/** The record in `storage()`, which defaults to `localStorage`. */
export function passkeyOfferRecord(storage?: () => Storage): PasskeyOfferRecord {
  const flag = deviceFlag(PASSKEY_OFFER_KEY, OFFER_VERSION, storage);
  return {
    answered: () => flag.isSet(),
    answer: () => {
      flag.set();
    },
  };
}
