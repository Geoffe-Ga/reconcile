/**
 * A group's nudge offset for a coalition motion (#284): HKDF of the group
 * secret under its own label and the motion's id, read as a whole number of
 * minutes below an hour. `vectors/nudge-offset.json`, computed with Python's
 * hmac and hashlib, pins it outside @noble; the properties pin that every
 * device of one group agrees, and that two groups' offsets for one motion
 * don't line up but by chance.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from './base64url';
import {
  NUDGE_OFFSET_LABEL,
  NUDGE_OFFSET_MINUTES,
  nudgeOffset,
  nudgeOffsetBytes,
  nudgeOffsetInfo,
} from './nudgeOffset';

/** `vectors/nudge-offset.json`: each secret, motion id and output is its bytes. */
interface NudgeOffsetFile {
  readonly kind: 'nudge-offset';
  readonly label: string;
  readonly vectors: readonly {
    readonly name: string;
    readonly secret: readonly number[];
    readonly motion: readonly number[];
    readonly okm: readonly number[];
    readonly offset: number;
  }[];
}

const [file] = Object.values(
  import.meta.glob<NudgeOffsetFile>('./vectors/nudge-offset.json', {
    import: 'default',
    eager: true,
  }),
);
if (file === undefined) throw new Error('vectors/nudge-offset.json is missing.');

/** A 32-byte group secret. */
const secret = fc.uint8Array({ minLength: 32, maxLength: 32 });

/** A motion's event id, as the event spells it: 32 bytes in unpadded base64url. */
const motionId = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((bytes) => base64url(bytes));

describe('nudge-offset.json (#284)', () => {
  it('names the label, an hour, and the info as the label, a 0x00 byte and the motion id', () => {
    expect(file.kind).toBe('nudge-offset');
    expect(file.label).toBe(NUDGE_OFFSET_LABEL);
    expect(NUDGE_OFFSET_LABEL).toBe('reconcile/v1/nudge-offset');
    expect(NUDGE_OFFSET_MINUTES).toBe(60);
    const id = 'A'.repeat(43);
    expect([...nudgeOffsetInfo(id)]).toEqual([
      ...new TextEncoder().encode('reconcile/v1/nudge-offset'),
      0,
      ...new TextEncoder().encode(id),
    ]);
  });

  it.each(file.vectors.map((vector) => [vector.name, vector] as const))(
    'gives the offset Python gives: %s',
    (_name, vector) => {
      const groupSecret = Uint8Array.from(vector.secret);
      const motion = base64url(Uint8Array.from(vector.motion));
      expect([...nudgeOffsetBytes(groupSecret, motion)]).toEqual(vector.okm);
      expect(nudgeOffset(groupSecret, motion)).toBe(vector.offset);
    },
  );
});

describe('nudgeOffset (#284)', () => {
  it('is a whole number of minutes from 0 to 59, and the same on every device that holds the secret', () => {
    fc.assert(
      fc.property(secret, motionId, (groupSecret, motion) => {
        const offset = nudgeOffset(groupSecret, motion);
        expect(Number.isInteger(offset)).toBe(true);
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(NUDGE_OFFSET_MINUTES);
        // Another device, with its own copy of the secret, gets the same.
        expect(nudgeOffset(Uint8Array.from(groupSecret), motion)).toBe(offset);
      }),
    );
  });

  it('derives other bytes for another group’s secret or another motion', () => {
    fc.assert(
      fc.property(secret, secret, motionId, motionId, (a, b, m, n) => {
        fc.pre(base64url(a) !== base64url(b) && m !== n);
        const bytes = base64url(nudgeOffsetBytes(a, m));
        expect(base64url(nudgeOffsetBytes(b, m))).not.toBe(bytes);
        expect(base64url(nudgeOffsetBytes(a, n))).not.toBe(bytes);
      }),
    );
  });

  it('spreads groups’ offsets for one motion evenly over the hour, so two line up only by chance', () => {
    const motion = base64url(new Uint8Array(32).fill(9));
    const draws = 6_000;
    const secrets = fc.sample(secret, { seed: 284, numRuns: draws });
    const counts = new Array<number>(NUDGE_OFFSET_MINUTES).fill(0);
    for (const groupSecret of secrets) {
      const offset = nudgeOffset(groupSecret, motion);
      counts[offset] = (counts[offset] ?? 0) + 1;
    }
    // A chi-square over 60 even buckets, 59 degrees of freedom: 112 is far past its 99.99th percentile.
    const expected = draws / NUDGE_OFFSET_MINUTES;
    const chiSquare = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    expect(chiSquare).toBeLessThan(112);
    // Two groups' offsets for the motion agree about 1 time in 60.
    const pairs = secrets.slice(1).filter((s, i) => {
      const before = secrets[i];
      return before !== undefined && nudgeOffset(s, motion) === nudgeOffset(before, motion);
    });
    expect(pairs.length).toBeGreaterThan(50);
    expect(pairs.length).toBeLessThan(150);
  });

  it('refuses a secret that isn’t 32 bytes, and an id that isn’t an event id', () => {
    const motion = base64url(new Uint8Array(32));
    expect(() => nudgeOffset(new Uint8Array(31), motion)).toThrow('A group secret is 32 bytes.');
    expect(() => nudgeOffset(new Uint8Array(32), 'not an id')).toThrow(
      'A nudge offset needs an event id.',
    );
  });
});
