/**
 * The pipeline as a matcher for #474's harness (#475): it runs Bedfellows for
 * one reader and one entry, and reads its row as the harness's verdict. A
 * verified row is common ground ("You both care about this:"), an unverified
 * one a shared subject ("You both write about this:"), and no row nothing.
 */
import type { AsyncMatcher } from './harness';
import { bedfellows } from './pipeline';
import type { Models } from './types';

/** The pipeline with `models` as an {@link AsyncMatcher}, at the dial's start. */
export function pipelineMatcher(models: Models): AsyncMatcher {
  return async (reader, entry) => {
    const [row] = await bedfellows({ reader: reader.documents, entries: [entry], dial: 0 }, models);
    if (row === undefined) return 'nothing';
    return row.reason.verified ? 'common-ground' : 'shared-subject';
  };
}
