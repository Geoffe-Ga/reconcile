/**
 * The steward's pinned public keys (#488; ADR-0081; docs/spec/listed-doors.md
 * §4.3 rule 1, §6.2).
 *
 * Two public keys ship in the app, as §6.2 says: `sign`, the Ed25519 key
 * that signs notices, which the relay's `RECONCILE_RELAY_SHELF_STEWARD_KEY`
 * holds too, and `box`, the X25519 key reports are sealed to (#489). Both
 * derive from the steward's one secret (`crypto/steward.ts`), which
 * `scripts/steward_key.py` makes offline.
 *
 * Every device's fold takes a notice only when it verifies against `sign`
 * here (`notices.ts`), so the relay alone can never release a listing, and
 * Settings takes a steward secret only when it derives exactly these two
 * keys. Rotating them is an app release and a relay setting (§6.2).
 *
 * **Set by the build (#505; HUMAN ACTION).** The pins are a build setting,
 * not source: the build reads `RECONCILE_STEWARD_PIN_SIGN` and
 * `RECONCILE_STEWARD_PIN_BOX` (`plugins/stewardPins.ts`, through
 * `vite.config.ts`'s `define`), and fails on a malformed one. The founder makes the key offline
 * and sets both for the deploy build (`deploy/README.md`). With neither set
 * the pins are null: no notice verifies on any device, so no listing shows on
 * the shelf, Settings offers no steward key and there is no console. A relay
 * without the steward key has no shelf either, so with neither set nothing a
 * person sees changes. `scripts/e2e.sh` builds with the tests' key, which
 * `deploy/deploy.sh` refuses to ship.
 * Tests run against a key of their own (`src/test/steward.ts`).
 */

/** The steward's two public keys, each in unpadded base64url. */
export interface StewardPins {
  /** The Ed25519 key that signs notices: the steward's shelf address. */
  readonly sign: string;
  /** The X25519 key reports are sealed to (#489). */
  readonly box: string;
}

/** What the build defines from its settings (`plugins/stewardPins.ts`). */
declare const __RECONCILE_STEWARD_PINS__: StewardPins | null;

/** The pinned keys, or null when the build sets none (HUMAN ACTION, #488, #505). */
export const STEWARD_PINS: StewardPins | null = __RECONCILE_STEWARD_PINS__;
