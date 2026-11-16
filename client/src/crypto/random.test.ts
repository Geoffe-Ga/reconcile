import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { drawBelow, type Random, randomBytes } from './random';

describe('randomBytes', () => {
  it('makes as many random bytes as asked, fresh each time (#126)', () => {
    const [a, b] = [randomBytes(6), randomBytes(6)];
    expect(a).toHaveLength(6);
    expect(b).toHaveLength(6);
    expect(a).not.toEqual(b);
    expect(randomBytes(0)).toHaveLength(0);
  });
});

/** `value`'s six bytes, big-endian. */
function bytesOf(value: number): Uint8Array {
  const bytes = new Uint8Array(6);
  let rest = value;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

/** A source that gives `value`'s bytes, and records each length asked for. */
function fixed(value: number): Random & { readonly asked: number[] } {
  const asked: number[] = [];
  const random = (length: number) => {
    asked.push(length);
    return bytesOf(value).slice(0, length);
  };
  return Object.assign(random, { asked });
}

describe('drawBelow (#126, #356)', () => {
  it('reads six bytes, big-endian, and takes them modulo the span', () => {
    const random = fixed(4_211);
    expect(drawBelow(10_080, random)).toBe(4_211);
    expect(random.asked).toEqual([6]);
    expect(drawBelow(1_440, fixed(2 ** 48 - 1))).toBe((2 ** 48 - 1) % 1_440);
    expect(drawBelow(1_440, fixed(1_440))).toBe(0);
    expect(drawBelow(1_440, fixed(1_439))).toBe(1_439);
    expect(drawBelow(1, fixed(2 ** 40 + 7))).toBe(0);
  });

  it('draws from 0 up to, but never at, the span, whatever the bytes (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 48 - 1 }),
        fc.integer({ min: 1, max: 2 ** 16 }),
        (value, span) => {
          const drawn = drawBelow(span, fixed(value));
          expect(Number.isInteger(drawn)).toBe(true);
          expect(drawn).toBeGreaterThanOrEqual(0);
          expect(drawn).toBeLessThan(span);
        },
      ),
    );
  });

  it('draws from the CSPRNG unless given a source', () => {
    const draws = new Set(Array.from({ length: 8 }, () => drawBelow(2 ** 40)));
    expect(draws.size).toBeGreaterThan(1);
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])(
    'refuses a span of %s, which holds no whole number to draw',
    (span) => {
      expect(() => drawBelow(span, fixed(1))).toThrow(RangeError);
    },
  );
});
