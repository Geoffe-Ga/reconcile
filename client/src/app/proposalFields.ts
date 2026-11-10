/**
 * The checks a new Proposal's title and why share on every composer that
 * has no draft: the steward composer (#102) and the dissolve composer (#108).
 * Limits count code points after NFC, as the fold does (spec §4), never
 * UTF-16 units.
 */
import { TITLE_MAX, WHY_MAX } from '../engine/fold';
import { nfcLength } from '../engine/text';
import { messages } from './messages';

/** A check that a trimmed value is there and at most `max` code points. */
function required(missing: string, max: number, tooLong: string) {
  return (value: string): string | null => {
    const text = value.trim();
    if (text === '') return missing;
    return nfcLength(text) > max ? tooLong : null;
  };
}

/** A title of 1–120 code points. */
export const checkTitle = required(
  messages.composer.titleMissing,
  TITLE_MAX,
  messages.composer.titleTooLong(TITLE_MAX),
);

/** A why of 1–2,000 code points. */
export const checkWhy = required(
  messages.composer.whyMissing,
  WHY_MAX,
  messages.composer.whyTooLong(WHY_MAX),
);
