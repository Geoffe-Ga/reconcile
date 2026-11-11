import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { authorOf } from '../test/keys';
import {
  ballotCommit,
  type CommittedBallot,
  commitEntries,
  countScores,
  scoresOf,
  versionCounts,
} from './commit';
import { base64url, type Score } from './event';

const score = fc.constantFrom<Score>(0, 1, 2, 3, 4);

/**
 * The commitment's bytes as Python computes them, independently of this engine:
 * `hashlib.sha256(b"reconcile/v1/ballot-commit" + b"\x00" + json.dumps(entries, separators=(",", ":")).encode())`.
 */
const PYTHON_COMMIT = [
  215, 33, 19, 93, 234, 34, 231, 207, 13, 92, 111, 161, 96, 231, 68, 174, 235, 17, 237, 113, 136,
  87, 18, 11, 111, 190, 57, 147, 151, 212, 134, 135,
];
/** The same, for no entries (`[]`). */
const PYTHON_EMPTY_COMMIT = [
  208, 183, 36, 44, 22, 104, 248, 224, 71, 255, 87, 192, 31, 67, 233, 74, 63, 178, 222, 254, 139,
  97, 114, 165, 24, 205, 138, 207, 73, 39, 76, 188,
];

describe('ballotCommit', () => {
  it('is the base64url SHA-256 of the tag, a zero byte and the entries as JSON, as Python computes it', () => {
    const entries = [
      ['voter-a', [0, 3], ''],
      ['voter-b', [4, null], 'c2FsdC1i'],
    ] as const;
    expect(ballotCommit(entries)).toBe(base64url(Uint8Array.from(PYTHON_COMMIT)));
    expect(ballotCommit([])).toBe(base64url(Uint8Array.from(PYTHON_EMPTY_COMMIT)));
  });

  it('sorts the entries by voter key itself, so it never depends on ballot order (property)', () => {
    const entry = fc.tuple(
      fc.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      fc.array(fc.option(score, { nil: null }), { minLength: 1, maxLength: 3 }),
      fc.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    );
    const scenario = fc
      .uniqueArray(entry, { selector: ([voter]) => voter, maxLength: 12 })
      .chain((entries) =>
        fc.record({
          entries: fc.constant(entries),
          shuffled: fc.shuffledSubarray(entries, { minLength: entries.length }),
        }),
      );
    fc.assert(
      fc.property(scenario, ({ entries, shuffled }) => {
        expect(ballotCommit(shuffled)).toBe(ballotCommit(entries));
      }),
    );
  });

  it('compares voter keys by code unit, never by locale', () => {
    // "Z" (U+005A) sorts before "a" (U+0061) by code unit; a locale collation would swap them.
    const forward = ballotCommit([
      ['Zed', [1], ''],
      ['ana', [2], ''],
    ]);
    expect(forward).toBe(
      ballotCommit([
        ['ana', [2], ''],
        ['Zed', [1], ''],
      ]),
    );
    expect(commitEntries(['v'], [ballot('ana', { v: 2 }), ballot('Zed', { v: 1 })])).toEqual([
      ['Zed', [1], ''],
      ['ana', [2], ''],
    ]);
  });

  it('changes when any score, salt or voter changes', () => {
    const base = ballotCommit([['voter-a', [3], 'salt']]);
    expect(ballotCommit([['voter-a', [2], 'salt']])).not.toBe(base);
    expect(ballotCommit([['voter-a', [3], 'salu']])).not.toBe(base);
    expect(ballotCommit([['voter-b', [3], 'salt']])).not.toBe(base);
    expect(ballotCommit([['voter-a', [null], 'salt']])).not.toBe(base);
  });
});

/** A counted ballot by `voter`, with no salt unless one is given. */
function ballot(
  voter: string,
  scores: Readonly<Record<string, Score>>,
  salt = '',
): CommittedBallot {
  return { voter, scores, salt };
}

describe('commitEntries', () => {
  it('lists each ballot as its voter, its scores in version order (null if unscored) and its salt', () => {
    const ballots = [ballot('ben', { v2: 4 }, 'sb'), ballot('ana', { v1: 0, v2: 3 }, 'sa')];
    expect(commitEntries(['v1', 'v2'], ballots)).toEqual([
      ['ana', [0, 3], 'sa'],
      ['ben', [null, 4], 'sb'],
    ]);
  });

  it('enters a ballot cast before salts with an empty salt', () => {
    expect(commitEntries(['v1'], [ballot('ana', { v1: 2 })])).toEqual([['ana', [2], '']]);
  });

  it('never carries a note, so two ballot sets that differ only in notes commit alike', () => {
    const plain = [ballot('ana', { v1: 0 }, 's')];
    const noted = [{ ...ballot('ana', { v1: 0 }, 's'), note: 'A private reason.' }];
    expect(ballotCommit(commitEntries(['v1'], noted))).toBe(
      ballotCommit(commitEntries(['v1'], plain)),
    );
    expect(JSON.stringify(commitEntries(['v1'], noted))).not.toContain('private');
  });
});

describe('countScores and versionCounts', () => {
  it('counts how many ballots gave each score, 0 through 4', () => {
    expect(countScores([4, 0, 4, 2])).toEqual([1, 0, 1, 0, 2]);
    expect(countScores([])).toEqual([0, 0, 0, 0, 0]);
  });

  it('expands counts back into scores, in score order (property)', () => {
    fc.assert(
      fc.property(fc.array(score, { maxLength: 30 }), (scores) => {
        expect(scoresOf(countScores(scores))).toEqual([...scores].sort((a, b) => a - b));
      }),
    );
  });

  it('counts each version’s scores across the ballots, leaving out a ballot that skipped it', () => {
    const ballots = [ballot('ana', { v1: 0, v2: 3 }), ballot('ben', { v2: 4 })];
    expect(versionCounts(['v1', 'v2'], ballots)).toEqual([
      [1, 0, 0, 0, 0],
      [0, 0, 0, 1, 1],
    ]);
  });
});

/** Every way to give `voters` the scores `counts` holds, one score each. */
function assignments(counts: readonly number[], voters: number): Score[][] {
  if (voters === 0) return counts.every((n) => n === 0) ? [[]] : [];
  return counts.flatMap((n, value) => {
    if (n === 0) return [];
    const rest = counts.map((m, i) => (i === value ? m - 1 : m));
    return assignments(rest, voters - 1).map((tail) => [value as Score, ...tail]);
  });
}

/** The real ballots of a 4-voter result, each with the salt `salt(i)`. */
function fourVoters(salt: (i: number) => string): CommittedBallot[] {
  const scores: Score[] = [4, 0, 3, 3];
  return ['ana', 'ben', 'cal', 'dee'].map((name, i) =>
    ballot(authorOf(name), { v1: scores[i] ?? 0 }, salt(i)),
  );
}

/** Each assignment of the counts to the voters whose commitment, with no salt, equals `commit`. */
function search(ballots: readonly CommittedBallot[], commit: string): Score[][] {
  const counts = versionCounts(['v1'], ballots)[0] ?? [];
  const voters = ballots.map((b) => b.voter);
  return assignments(counts, voters.length).filter((guess) => {
    const guessed = voters.map((voter, i) => ballot(voter, { v1: guess[i] ?? 0 }));
    return ballotCommit(commitEntries(['v1'], guessed)) === commit;
  });
}

describe('the commitment once the ballots are gone', () => {
  it('can’t be tested against guesses: no assignment consistent with the counts matches it', () => {
    const salted = fourVoters(() => base64url(crypto.getRandomValues(new Uint8Array(16))));
    const commit = ballotCommit(commitEntries(['v1'], salted));
    // 4 voters with scores {4, 0, 3, 3} can be assigned 4!/2! = 12 ways.
    expect(assignments(versionCounts(['v1'], salted)[0] ?? [], 4)).toHaveLength(12);
    expect(search(salted, commit)).toEqual([]);
  });

  it('would give the ballots away without salts: the search then finds exactly the real ones', () => {
    const unsalted = fourVoters(() => '');
    const commit = ballotCommit(commitEntries(['v1'], unsalted));
    expect(search(unsalted, commit)).toEqual([[4, 0, 3, 3]]);
  });
});
