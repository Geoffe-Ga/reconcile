/**
 * The Document an invite carries, read before joining (#91; ADR-0052).
 *
 * The envelope already holds the group's relay-accepted log (#73), so Join
 * folds it in memory to show the founding Document as it reads now. The fold
 * is sync's own: each record must verify before it counts, a repeated event
 * id is dropped, and the invite GET's `now` stands in for the relay's, so a
 * Proposal that reached its deadline has changed its section. Nothing here
 * stores anything, makes a key or sends a request.
 */
import { type Atom, fold, type GroupState, type LogRecord } from '../engine/fold';

/**
 * What {@link foldInvite} reads from an opened invite: its entries, the
 * invite GET's `now`, and the Proposals whose ballots the inviter cleared
 * (#111), whose outcomes the fold takes from their results.
 */
export interface InvitePage {
  readonly records: readonly LogRecord[];
  readonly relayNow: number;
  readonly cleared?: readonly string[];
}

/**
 * The genesis Document of `state`: the Atoms whose `documentId` is the
 * genesis id, each with its current text, or null before a genesis.
 */
export function genesisDocument(state: GroupState): readonly Atom[] | null {
  const { group, atoms } = state;
  if (group === null) return null;
  return atoms.filter((atom) => atom.documentId === group);
}

/** The genesis Document folded from an invite's entries, or null when they hold no genesis. */
export function foldInvite({
  records,
  relayNow,
  cleared = [],
}: InvitePage): readonly Atom[] | null {
  return genesisDocument(fold(records, relayNow, [], cleared));
}
