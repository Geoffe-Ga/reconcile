/**
 * Records that keep their secrets in the vault (#255, #265): one mechanism
 * for every store whose records hold a secret beside what they say.
 *
 * A record's {@link Sealing} names its secret fields and splits it in two:
 * what IndexedDB keeps under a vault, with no secret in it, and its secrets,
 * which the vault keeps by the record's store and id (`./vault.ts`). On a
 * device with no vault a record keeps its secrets itself, as it always did.
 * The store's one key-writing path, `keepKeys` (`./db.ts`), splits each such
 * record it writes when there's a vault, and every read that hands one back
 * whole joins it again: with the secrets it still holds itself, as a record
 * kept before #255 does until the device seals or unlocks, or else the
 * vault's, which a locked device refuses to open. With a vault, `keepKeys`
 * refuses a record that has secrets its split doesn't take, one holding only
 * some of its keys, rather than write it as it is, its keys in the clear
 * (#391).
 *
 * A shared personal Document's share keys (`shareSealing`, `./personal.ts`),
 * a sent front-door application's reply keys (`replySealing`,
 * `./applications.ts`) and a recovering device's request keys
 * (`requestSealing`, `./recoverRequest.ts`, #118, in the device store) work
 * this way, with no new vault format.
 */
import type { Secrets } from './vault';

/** A record split by its {@link Sealing}: what IndexedDB keeps, and the secrets taken out. */
export interface Split<Kept> {
  /** The record with no secret in it. */
  readonly kept: Kept;
  /** The secrets it held in the clear, or null when it held none, or not all of them. */
  readonly secrets: Secrets | null;
}

/**
 * How one store's records keep their secrets apart (#255, #265). `Kept` is
 * the record as IndexedDB may hold it, its secrets in it or not; `Whole` the
 * record with every secret it has.
 */
export interface Sealing<Whole extends Kept, Kept> {
  /** Whether `record` has any secret, in it or in the vault. */
  hasSecrets(record: Kept): boolean;
  /**
   * `record` without its secrets, and the secrets it held in the clear. A
   * record that holds only some of them, or none, stays as it is.
   */
  split(record: Kept): Split<Kept>;
  /**
   * `kept` whole, with `secrets` put back: as `split` left it, or null when
   * it has secrets that `secrets` doesn't hold.
   */
  join(kept: Kept, secrets: Secrets | undefined): Whole | null;
}

/**
 * `record` whole: with the secrets it holds in the clear, or else `sealed`,
 * the vault's for it.
 *
 * @throws {Error} when it has secrets that are in neither.
 */
export function wholeRecord<Whole extends Kept, Kept>(
  sealing: Sealing<Whole, Kept>,
  record: Kept,
  sealed: Secrets | undefined,
): Whole {
  const { kept, secrets } = sealing.split(record);
  const whole = sealing.join(kept, secrets ?? sealed);
  if (whole === null) throw new Error('A record’s keys are missing from this device.');
  return whole;
}

/**
 * Each of `records` that still holds its secrets in the clear, whole: what
 * sealing the device's keys, or a first unlock after #255, moves into the vault.
 */
export function plainRecords<Whole extends Kept, Kept>(
  sealing: Sealing<Whole, Kept>,
  records: readonly Kept[],
): Whole[] {
  return records.flatMap((record) => {
    const { kept, secrets } = sealing.split(record);
    const whole = secrets === null ? null : sealing.join(kept, secrets);
    return whole === null ? [] : [whole];
  });
}
