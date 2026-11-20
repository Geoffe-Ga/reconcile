/**
 * The shared-enemy check (#481; ADR-0080 §6): a zero-shot question to a
 * stance model, and its measurement on the corpus's labels.
 */
import { describe, expect, it } from 'vitest';

import type { Corpus, Entry } from './corpus';
import { heldOutHostilityReport, hostilityReport } from './harness';
import { HOSTILITY_HYPOTHESIS, modelHostility, SHARED_ENEMY_CHECK } from './hostility';
import type { PairClassifier } from './runtime';
import { THRESHOLDS } from './thresholds';
import type { HostilityCheck } from './types';

/** A classifier whose entailment (output 0) is `scores[premise]`, recording each ask. */
function classifierOf(scores: Record<string, number>): PairClassifier & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    classify: (premise, hypothesis) => {
      asked.push([premise, hypothesis]);
      const entailment = scores[premise] ?? 0;
      return Promise.resolve(Float32Array.from([entailment, 1 - entailment]));
    },
  };
}

/** A shelf entry for a made-up corpus. */
function entryOf(fields: Partial<Entry> & Pick<Entry, 'id' | 'title' | 'text'>): Entry {
  return { split: 'tune', hostile: false, publisher: 'g1', subject: 'parks', ...fields };
}

/** A check that flags exactly the sentences in `hostile`. */
function flagging(...hostile: string[]): HostilityCheck {
  const flagged = new Set(hostile);
  return { isMainlyHostile: (sentence) => Promise.resolve(flagged.has(sentence)) };
}

const CORPUS: Corpus = {
  readers: [],
  publishers: [],
  pairs: [],
  entries: [
    entryOf({
      id: 'h1',
      title: 'Drive them out of town',
      text: 'Every one of the newcomers is a thief. Nobody should rent them a room.',
      hostile: true,
    }),
    entryOf({
      id: 'h2',
      title: 'Leave the hunters alone',
      text: 'We meet on Sundays by the river. Bring a flask and a friend.',
      hostile: true,
      subject: 'hunting',
    }),
    entryOf({
      id: 'a1',
      title: 'The water company lied',
      text: 'The water company lied to every family on the estate. We want answers by Friday.',
      angerAtPowerful: true,
      subject: 'environment',
    }),
    entryOf({
      id: 'o1',
      title: 'Seeds for the spring swap',
      text: 'Bring your spare seeds to the hall on Saturday. Everyone is welcome to the swap.',
      subject: 'food',
    }),
    entryOf({
      id: 'x1',
      title: 'Held out',
      text: 'Our held-out entry says something here.',
      split: 'held-out',
    }),
  ],
};

describe('modelHostility (#481)', () => {
  it('asks the model whether the sentence is mainly hostility, the sentence as premise', async () => {
    const classifier = classifierOf({});

    await modelHostility(classifier, { entailment: 0 }).isMainlyHostile('They are all thieves.');

    expect(classifier.asked).toEqual([['They are all thieves.', HOSTILITY_HYPOTHESIS]]);
  });

  it('flags a sentence whose entailment reaches the bar, and nothing under it', async () => {
    const bar = THRESHOLDS.hostility.entails;
    // The model answers in 32-bit floats: just over the bar stays over it.
    const check = modelHostility(classifierOf({ at: bar + 1e-6, under: bar - 0.01 }), {
      entailment: 0,
    });

    expect(await check.isMainlyHostile('at')).toBe(true);
    expect(await check.isMainlyHostile('under')).toBe(false);
  });

  it('reads entailment from the label the model names, and an absent one as never reached', async () => {
    const classifier = classifierOf({ s: 0.99 });

    expect(await modelHostility(classifier, { entailment: 0 }, 0.5).isMainlyHostile('s')).toBe(
      true,
    );
    expect(await modelHostility(classifier, { entailment: 1 }, 0.5).isMainlyHostile('s')).toBe(
      false,
    );
    expect(await modelHostility(classifier, { entailment: 2 }, 0.5).isMainlyHostile('s')).toBe(
      false,
    );
  });

  it('ships switched off: it is measured not to help (ADR-0080 §6)', () => {
    expect(SHARED_ENEMY_CHECK).toBe(false);
  });
});

describe('hostilityReport (#481)', () => {
  it('counts the hostile entries caught, by any claim and by claim, and the others flagged', async () => {
    const report = await hostilityReport(
      flagging(
        'Every one of the newcomers is a thief.',
        'The water company lied to every family on the estate.',
      ),
      'tune',
      CORPUS,
    );

    expect(report.split).toBe('tune');
    expect(report.hostile).toEqual({ entries: 2, flagged: 1, claims: 6, claimsFlagged: 1 });
    expect(report.others).toEqual({ entries: 2, flagged: 1, claims: 6, claimsFlagged: 1 });
    expect(report.angerAtPowerful).toEqual({ entries: 1, flagged: 1, claims: 3, claimsFlagged: 1 });
    expect(report.othersFlaggedBySubject).toEqual({ environment: 1 });
    expect(report.flaggedOthers).toEqual(['a1']);
    expect(report.missedHostile).toEqual(['h2']);
  });

  it('flags nothing with a check that never flags', async () => {
    const report = await hostilityReport(flagging(), 'tune', CORPUS);

    expect(report.hostile.flagged).toBe(0);
    expect(report.others.flagged).toBe(0);
    expect(report.othersFlaggedBySubject).toEqual({});
  });

  it('gives held-out numbers only when asked for by name', async () => {
    await expect(hostilityReport(flagging(), 'held-out', CORPUS)).rejects.toThrow(
      'heldOutHostilityReport',
    );
    const held = await heldOutHostilityReport(flagging('Held out'), CORPUS);

    expect(held.split).toBe('held-out');
    expect(held.others).toEqual({ entries: 1, flagged: 1, claims: 2, claimsFlagged: 1 });
  });

  it('reads the repository’s corpus by default', async () => {
    const report = await hostilityReport(flagging(), 'tune');

    expect(report.hostile.entries).toBe(16);
    expect(report.angerAtPowerful.entries).toBe(9);
  });
});
