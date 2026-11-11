/**
 * What a result carries about the ballots it closes (#111; ADR-0017;
 * docs/spec/phase-1-spec.md §4): each version's counts, and a commitment to
 * the counted ballots.
 *
 * The commitment is the unpadded base64url SHA-256 of
 * `"reconcile/v1/ballot-commit" ‖ 0x00 ‖ utf8(JSON.stringify(entries))`, where
 * `entries` lists each counted ballot as `[voterKey, scores in version order
 * (null if unscored), salt]`, sorted by voter key in code-unit order, never by
 * locale. Notes never enter it (ADR-0065 §3). Each ballot's random salt means
 * nobody can test guessed ballots against it once the ballots are gone, so
 * the counts stay all that a cleared result tells anyone.
 */
import { base64url } from '../crypto/base64url';
import { sha256 } from '../crypto/hash';
import type { Score, ScoreCounts } from './event';

/** The domain tag the commitment hashes first, so it can't be mistaken for any other hash. */
export const BALLOT_COMMIT_TAG = 'reconcile/v1/ballot-commit';

/** One counted ballot as the commitment lists it: its voter, its scores in version order, its salt. */
export type CommitEntry = readonly [voter: string, scores: readonly (Score | null)[], salt: string];

/** What the commitment and the counts read of a counted ballot. A note is never read. */
export interface CommittedBallot {
  readonly voter: string;
  readonly scores: Readonly<Record<string, Score>>;
  readonly salt: string;
}

const encoder = new TextEncoder();

/** Code-unit order on voter keys: the same on every device, whatever its locale. */
function byVoter(a: CommitEntry, b: CommitEntry): number {
  if (a[0] === b[0]) return 0;
  return a[0] < b[0] ? -1 : 1;
}

/** The commitment to `entries`, which it sorts by voter key first, so their order never matters. */
export function ballotCommit(entries: readonly CommitEntry[]): string {
  const json = encoder.encode(JSON.stringify([...entries].sort(byVoter)));
  const tag = encoder.encode(BALLOT_COMMIT_TAG);
  const message = new Uint8Array(tag.length + 1 + json.length);
  message.set(tag);
  message.set(json, tag.length + 1);
  return base64url(sha256(message));
}

/** Each ballot's entry, its scores in the order of `versionIds`, sorted by voter key. */
export function commitEntries(
  versionIds: readonly string[],
  ballots: readonly CommittedBallot[],
): CommitEntry[] {
  return ballots
    .map((ballot): CommitEntry => [
      ballot.voter,
      versionIds.map((id) => scoreOn(ballot, id)),
      ballot.salt,
    ])
    .sort(byVoter);
}

/** How many of `scores` are each value from 0 to 4. */
export function countScores(scores: readonly Score[]): ScoreCounts {
  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const score of scores) counts[score] += 1;
  return counts;
}

/** Every score, in order. */
const SCORES = [0, 1, 2, 3, 4] as const satisfies readonly Score[];

/** The scores `counts` stands for, lowest first: what the tally reads of a cleared result. */
export function scoresOf(counts: ScoreCounts): Score[] {
  return SCORES.flatMap((value) => Array.from({ length: counts[value] }, () => value));
}

/** The score `ballot` gave version `id`, or null when it left that version unscored. */
function scoreOn(ballot: CommittedBallot, id: string): Score | null {
  return Object.hasOwn(ballot.scores, id) ? (ballot.scores[id] ?? null) : null;
}

/** How many of `ballots` gave version `id` each score, leaving out any that didn't score it. */
export function scoreCounts(ballots: readonly CommittedBallot[], id: string): ScoreCounts {
  return countScores(
    ballots.flatMap((ballot) => {
      const score = scoreOn(ballot, id);
      return score === null ? [] : [score];
    }),
  );
}

/** Each version's counts across `ballots`, in the order of `versionIds`. */
export function versionCounts(
  versionIds: readonly string[],
  ballots: readonly CommittedBallot[],
): ScoreCounts[] {
  return versionIds.map((id) => scoreCounts(ballots, id));
}
