/**
 * Reading a JSON object out of an opened box's plaintext (#109, #118): the
 * one parse the recovery boxes share, so each answers null alike for bad
 * UTF-8, bad JSON and anything but an object.
 */

/** The JSON object in `plaintext`, or null for bad UTF-8, bad JSON or anything but an object. */
export function objectIn(plaintext: Uint8Array): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}
