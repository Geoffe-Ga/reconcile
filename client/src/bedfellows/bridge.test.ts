/**
 * The bridging bonus (#479; ADR-0080 §6): an entry with candidate pairs in two
 * or more of the reader's Documents that are unlike each other bridges them.
 */
import { describe, expect, it } from 'vitest';

import { bridges, documentsOf } from './bridge';
import { THRESHOLDS } from './thresholds';

/** A unit vector at `degrees` in the plane: two of them have cosine cos(difference). */
function at(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

describe('documentsOf (#479)', () => {
  it('names each Document that holds one of the sentences, once, in order', () => {
    const documents = [['A', 'B'], ['C'], ['B', 'D']];

    expect(documentsOf(['B', 'A'], documents)).toEqual([0, 2]);
    expect(documentsOf(['C', 'D', 'C'], documents)).toEqual([1, 2]);
    expect(documentsOf(['Z'], documents)).toEqual([]);
  });
});

describe('bridges (#479)', () => {
  const unlike = THRESHOLDS.bridge.unlikeBelow;

  it('says yes for pairs in two Documents unlike each other', () => {
    expect(bridges([0, 1], [at(0), at(90)], unlike)).toBe(true);
  });

  it('says no for two Documents alike, at or above the line', () => {
    const atLine = (Math.acos(unlike) * 180) / Math.PI;
    expect(bridges([0, 1], [at(0), at(10)], unlike)).toBe(false);
    expect(bridges([0, 1], [at(0), at(atLine - 0.01)], unlike)).toBe(false);
    expect(bridges([0, 1], [at(0), at(atLine + 0.01)], unlike)).toBe(true);
  });

  it('finds an unlike pair among three Documents', () => {
    expect(bridges([0, 1, 2], [at(0), at(10), at(80)], unlike)).toBe(true);
  });

  it('gives a reader with one Document no bonus, and no error', () => {
    expect(bridges([0], [at(0)], unlike)).toBe(false);
    expect(bridges([], [], unlike)).toBe(false);
  });

  it('reads a Document with no vector as unlike nothing', () => {
    expect(bridges([0, 3], [at(0)], unlike)).toBe(false);
  });

  it('states its line: Documents less alike than a restated claim', () => {
    expect(unlike).toBe(THRESHOLDS.counterpart);
  });
});
