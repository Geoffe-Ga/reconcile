/**
 * Tiers (#477; ADR-0080 §4): an entry of three claims or more is placed by
 * its strangeness, one minus its coverage; a shorter one by its best pair's
 * strength and how near its claims sit to the reader's nearest Document.
 */
import { describe, expect, it } from 'vitest';

import { centroid, nearestDocument, tierByStrangeness, tierOfShortEntry } from './tiers';

const CUTS = {
  strangeness: { closeBelow: 0.4, strangeFrom: 0.7 },
  shortEntry: { claims: 3, close: 0.6, middle: 0.45 },
};

/** A unit vector at `degrees` in the plane. */
function at(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

describe('tierByStrangeness (#477)', () => {
  it('cuts strangeness into close below closeBelow, strange from strangeFrom, middle between', () => {
    expect(tierByStrangeness(0.39, CUTS)).toBe('close');
    expect(tierByStrangeness(0.4, CUTS)).toBe('middle');
    expect(tierByStrangeness(0.69, CUTS)).toBe('middle');
    expect(tierByStrangeness(0.7, CUTS)).toBe('strange');
  });
});

describe('centroid (#477)', () => {
  it('is the mean of the vectors scaled to unit length', () => {
    const [x, y] = centroid([at(0), at(90)]);
    expect(x).toBeCloseTo(Math.SQRT1_2, 10);
    expect(y).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('is the zero vector for no vectors, or ones that cancel', () => {
    expect(centroid([])).toEqual([]);
    expect(
      centroid([
        [1, 0],
        [-1, 0],
      ]),
    ).toEqual([0, 0]);
  });
});

describe('nearestDocument (#477)', () => {
  it('is the cosine of the entry’s centroid with the nearest Document’s', () => {
    const entry = [at(0), at(20)];
    const documents = [
      [at(80), at(100)],
      [at(30), at(50)],
    ];

    expect(nearestDocument(entry, documents)).toBeCloseTo(Math.cos((30 * Math.PI) / 180), 10);
  });

  it('is 0 with no Documents', () => {
    expect(nearestDocument([at(0)], [])).toBe(0);
  });
});

describe('tierOfShortEntry (#477)', () => {
  it('places a short entry by the mean of its best pair’s strength and its nearest Document', () => {
    expect(tierOfShortEntry(0.7, 0.5, CUTS)).toBe('close');
    expect(tierOfShortEntry(0.7, 0.4, CUTS)).toBe('middle');
    expect(tierOfShortEntry(0.5, 0.4, CUTS)).toBe('middle');
    expect(tierOfShortEntry(0.5, 0.3, CUTS)).toBe('strange');
  });

  it('lets a strong pair in a far Document place lower than the same pair in a near one', () => {
    expect(tierOfShortEntry(0.8, 0.5, CUTS)).toBe('close');
    expect(tierOfShortEntry(0.8, 0.1, CUTS)).toBe('middle');
  });
});
