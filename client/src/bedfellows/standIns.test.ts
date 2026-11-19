/**
 * The stand-in models (#475): a splitter, an embedder and a judge that keep
 * the pipeline whole until each later issue in #473 swaps in a real one. They
 * are crude on purpose; these tests pin only what the pipeline leans on: the
 * splitter cuts on sentence punctuation, the embedder is deterministic and
 * puts shared words close, and the judge never claims a stance.
 */
import { describe, expect, it } from 'vitest';

import { cosine } from './pipeline';
import { standInEmbedder, standInJudge, standInSplitter } from './standIns';

describe('standInSplitter (#475)', () => {
  it('cuts on sentence punctuation and blank lines, and drops blanks', () => {
    expect(standInSplitter('Keep it open. Every day!\n\nWhy not?  ')).toEqual([
      'Keep it open.',
      'Every day!',
      'Why not?',
    ]);
    expect(standInSplitter('  ')).toEqual([]);
  });
});

describe('standInEmbedder (#475)', () => {
  it('gives one vector of a small fixed size for each sentence, in order', async () => {
    const vectors = await standInEmbedder.embed(['Keep the library open.', 'Feed the ducks.']);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(standInEmbedder.dimensions);
    expect(vectors[1]).toHaveLength(standInEmbedder.dimensions);
    expect(standInEmbedder.dimensions).toBeLessThanOrEqual(512);
  });

  it('gives the same sentence the same vector every time, whatever it is embedded beside', async () => {
    const [alone] = await standInEmbedder.embed(['Keep the library open.']);
    const [, beside] = await standInEmbedder.embed(['Feed the ducks.', 'Keep the library open.']);

    expect(beside).toEqual(alone);
  });

  it('puts sentences that share content words closer than sentences that share none', async () => {
    const [mine, shared, apart] = await standInEmbedder.embed([
      'Keep the library open on Sundays.',
      'We want the library open.',
      'Feed the ducks at the pond.',
    ]);
    if (mine === undefined || shared === undefined || apart === undefined) throw new Error('3');

    expect(cosine(mine, shared)).toBeGreaterThan(0.5);
    expect(cosine(mine, apart)).toBeLessThan(0.2);
    expect(cosine(mine, mine)).toBeCloseTo(1, 10);
  });

  it('gives a sentence of only common words the zero vector, which matches nothing', async () => {
    const [empty, other] = await standInEmbedder.embed(['It is what it is.', 'Open it.']);
    if (empty === undefined || other === undefined) throw new Error('2');

    expect(empty.every((x) => x === 0)).toBe(true);
    expect(cosine(empty, other)).toBe(0);
  });
});

describe('cosine (#475)', () => {
  it('is the cosine of the angle between two vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 1], [2, 2])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [-1, 0])).toBe(-1);
  });
});

describe('standInJudge (#475)', () => {
  it('is never sure: it answers unsure for agreement, opposition and nonsense alike', async () => {
    await expect(
      standInJudge.judge('Keep the library open.', 'Keep the library open.'),
    ).resolves.toBe('unsure');
    await expect(
      standInJudge.judge('End the deer season.', 'Protect the deer season.'),
    ).resolves.toBe('unsure');
  });
});
