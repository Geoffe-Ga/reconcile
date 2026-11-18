/**
 * The steward's pins as a build setting (#505; ADR-0081's amendment of
 * 2026-11-18; docs/spec/listed-doors.md §6.2).
 *
 * The app's two pinned public keys (`src/shelf/steward.ts`) come from the
 * build's environment: `RECONCILE_STEWARD_PIN_SIGN` and
 * `RECONCILE_STEWARD_PIN_BOX`, each 43 characters of canonical unpadded
 * base64url, as `scripts/steward_key.py` prints them. `vite.config.ts`
 * defines the app's pins from them through {@link stewardPinsDefine}, which
 * runs in Node when the build starts:
 *
 * - **Neither set** (or both empty): the pins are null, so no notice
 *   verifies and nothing a person sees changes.
 * - **Both set and well formed:** those are the pins.
 * - **Anything else** (one without the other, or either not a 32-byte key in
 *   canonical unpadded base64url): it throws, so the build fails rather than
 *   ship a key no steward can use.
 *
 * `scripts/e2e.sh` builds with the tests' key (`src/test/steward.ts`), and
 * `../deploy/deploy.sh` refuses a build that carries it. The app checks more
 * of a key than its spelling when it uses it (`src/shelf/notices.ts`).
 */

/** The setting that holds the Ed25519 key that signs notices. */
export const PIN_SIGN_SETTING = 'RECONCILE_STEWARD_PIN_SIGN';

/** The setting that holds the X25519 key reports are sealed to. */
export const PIN_BOX_SETTING = 'RECONCILE_STEWARD_PIN_BOX';

/** The identifier the build replaces with the pins (`src/shelf/steward.ts` reads it). */
export const PINS_GLOBAL = '__RECONCILE_STEWARD_PINS__';

/** A build's environment, as Node's `process.env` holds it. */
export type BuildEnv = Readonly<Record<string, string | undefined>>;

/** The steward's two public keys, as `src/shelf/steward.ts`'s `StewardPins`. */
export interface Pins {
  readonly sign: string;
  readonly box: string;
}

/** Whether `text` spells 32 bytes in canonical unpadded base64url. */
function isKey(text: string): boolean {
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === text;
}

/** The setting `name` must hold a key: say so. */
const malformed = (name: string): Error =>
  new Error(
    `${name} must be one of the steward’s public keys: 43 characters of canonical unpadded base64url, as scripts/steward_key.py prints it.`,
  );

/**
 * The pins the build's `env` sets, or null when it sets neither.
 *
 * @throws {Error} when only one is set, or either is malformed: the build fails.
 */
export function stewardPinsFrom(env: BuildEnv): Pins | null {
  const sign = env[PIN_SIGN_SETTING] ?? '';
  const box = env[PIN_BOX_SETTING] ?? '';
  if (sign === '' && box === '') return null;
  if (sign === '' || box === '') {
    throw new Error(`Set both ${PIN_SIGN_SETTING} and ${PIN_BOX_SETTING}, or neither.`);
  }
  if (!isKey(sign)) throw malformed(PIN_SIGN_SETTING);
  if (!isKey(box)) throw malformed(PIN_BOX_SETTING);
  return { sign, box };
}

/**
 * The `define` entry that sets the app's pins from the build's `env`.
 *
 * @throws {Error} as {@link stewardPinsFrom} does, which fails the build.
 */
export function stewardPinsDefine(env: BuildEnv): Record<string, string> {
  return { [PINS_GLOBAL]: JSON.stringify(stewardPinsFrom(env)) };
}
