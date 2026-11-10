import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sixDigits } from './sixDigits';

describe('sixDigits', () => {
  it('reads the 4 bytes as a big-endian number, mod a million, in six digits', () => {
    // 0x000a65cf = 681,423.
    expect(sixDigits(Uint8Array.from([0x00, 0x0a, 0x65, 0xcf]))).toBe('681423');
    // 0xffffffff = 4,294,967,295, so 967,295.
    expect(sixDigits(Uint8Array.from([0xff, 0xff, 0xff, 0xff]))).toBe('967295');
  });

  it('keeps leading zeros', () => {
    expect(sixDigits(Uint8Array.from([0, 0, 0, 0]))).toBe('000000');
    expect(sixDigits(Uint8Array.from([0, 0, 0, 7]))).toBe('000007');
    // 1,000,042 mod 10^6 = 42.
    expect(sixDigits(Uint8Array.from([0x00, 0x0f, 0x42, 0x6a]))).toBe('000042');
  });

  it('is unsigned: a high first byte never reads as negative', () => {
    // 0x80000000 = 2,147,483,648, so 483,648.
    expect(sixDigits(Uint8Array.from([0x80, 0, 0, 0]))).toBe('483648');
  });

  it('is always six digits that match the bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 4, maxLength: 4 }), (bytes) => {
        const digits = sixDigits(bytes);
        expect(digits).toMatch(/^[0-9]{6}$/);
        const value = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
        expect(Number(digits)).toBe(value % 1_000_000);
      }),
    );
  });

  it('refuses anything but 4 bytes', () => {
    for (const length of [0, 3, 5, 32]) {
      expect(() => sixDigits(new Uint8Array(length))).toThrow(
        new RangeError('A link number comes from 4 bytes.'),
      );
    }
  });
});
