/**
 * The pipeline as a harness matcher (#475; #474): a verified row is common
 * ground, an unverified one a shared subject, and no row nothing. Its numbers
 * on the `tune` split with the stand-ins are the floor every later issue in
 * #473 has to beat; the test pins only that they're measured, and that the
 * judge that is never sure never claims agreement.
 */
import { describe, expect, it } from 'vitest';

import type { Entry, Reader } from './corpus';
import { harnessAsync } from './harness';
import { pipelineMatcher } from './matcher';
import { standInEmbedder, standInJudge } from './standIns';
import type { Models, Stance } from './types';

/** A reader with one Document holding `text`. */
function reader(text: string): Reader {
  return { id: 'r', split: 'tune', community: 'a test', documents: [{ title: 'Ours', text }] };
}

/** An entry whose text is `text`. */
function entry(text: string): Entry {
  return {
    id: 'e',
    split: 'tune',
    title: '',
    text,
    hostile: false,
    publisher: 'g',
    subject: 'parks',
  };
}

/** The stand-in embedder with a judge that always answers `stance`. */
function judgingAll(stance: Stance): Models {
  return { embedder: standInEmbedder, judge: { judge: () => Promise.resolve(stance) } };
}

describe('pipelineMatcher (#475)', () => {
  const mine = reader('Keep the library open on Sundays.');
  const theirs = entry('We want the library open.');

  it('calls an entry with a verified row common ground', async () => {
    await expect(pipelineMatcher(judgingAll('agrees'))(mine, theirs)).resolves.toBe(
      'common-ground',
    );
  });

  it('calls an entry with an unverified row a shared subject', async () => {
    await expect(pipelineMatcher(judgingAll('unsure'))(mine, theirs)).resolves.toBe(
      'shared-subject',
    );
  });

  it('calls an entry with no row nothing', async () => {
    await expect(pipelineMatcher(judgingAll('opposes'))(mine, theirs)).resolves.toBe('nothing');
    await expect(
      pipelineMatcher(judgingAll('agrees'))(mine, entry('Feed the ducks.')),
    ).resolves.toBe('nothing');
  });

  it('runs on the tune split with the stand-ins, and never claims common ground there', async () => {
    const report = await harnessAsync(
      pipelineMatcher({ embedder: standInEmbedder, judge: standInJudge }),
      'tune',
    );

    expect(report.split).toBe('tune');
    expect(report.precision).toBeNull();
    expect(report.falseAgreement).toBe(0);
    expect(report.byKind['shared-claim'].pairs).toBeGreaterThan(0);
    expect(report.byKind['shared-claim'].sharedSubject).toBeGreaterThan(0);
  });
});
