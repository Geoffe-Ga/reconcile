/**
 * The checks a new Proposal's title and why share on every composer that
 * has no draft: the steward composer (#102), the dissolve composer (#108)
 * and the removal composer (#115); the one response on a removal; and a
 * Dispatch's title and text (#112), sent or carried by a Proposal.
 * Limits count code points after NFC, as the fold does (spec §4), never
 * UTF-16 units.
 */
import { DISPATCH_TEXT_MAX, DISPATCH_TITLE_MAX } from '../engine/dispatches';
import { TITLE_MAX, WHY_MAX } from '../engine/fold';
import { RESPONSE_MAX } from '../engine/removal';
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

/** A removal response of 1–1,000 code points (#115; ADR-0072 §4). */
export const checkResponse = required(
  messages.removal.respondEmpty,
  RESPONSE_MAX,
  messages.removal.respondTooLong(RESPONSE_MAX),
);

/** A Dispatch's title of 1–80 code points (#112). */
export const checkDispatchTitle = required(
  messages.sendDispatch.titleMissing,
  DISPATCH_TITLE_MAX,
  messages.composer.titleTooLong(DISPATCH_TITLE_MAX),
);

/** A Dispatch's text of at most 500 code points, blank allowed (#112). */
export function checkDispatchText(value: string): string | null {
  return nfcLength(value.trim()) > DISPATCH_TEXT_MAX
    ? messages.composer.whyTooLong(DISPATCH_TEXT_MAX)
    : null;
}
