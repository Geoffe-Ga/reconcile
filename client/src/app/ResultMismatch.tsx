import { messages } from './messages';

/** Props for {@link ResultMismatch}. */
export interface ResultMismatchProps {
  /**
   * The results a coalition recorded for the group's seat that its own vote
   * doesn't match (`resultMismatches`, #100): how many, or none.
   */
  readonly count: number;
}

/**
 * What a group sees when a coalition recorded a result for its seat that
 * doesn't match its own vote (#114; ADR-0075 §1): one plain line, so its
 * members can talk it out. Anyone holding the group's seat secret can post
 * one, so it names no one. Nothing when there's none.
 */
export function ResultMismatch({ count }: ResultMismatchProps) {
  if (count === 0) return null;
  return <p className="notice result-mismatch">{messages.coalitions.mismatch}</p>;
}
