/**
 * What the composer and the ballot do (spec §4 and §8), apart from any screen.
 *
 * Each action writes one event with the engine, keeps it in the store's
 * outbox, and asks the sync loop to send it at once. Folded state still comes
 * only from relay records: a Proposal appears, and a ballot counts, once the
 * relay has ordered and timed it.
 */
import { MAX_PLAINTEXT_BYTES } from '../crypto/seal';
import { createEvent, type Score } from '../engine/event';
import type { Services } from './actions';

/** What the actions here use. */
export type ProposalServices = Pick<Services, 'store' | 'sync' | 'now'>;

/** A Proposal's entries: title and why trimmed, the link null when blank. */
export interface ProposalValues {
  /** The Atom whose text it would replace. */
  readonly atom: string;
  readonly title: string;
  readonly why: string;
  /** The proposed text, as typed. */
  readonly text: string;
  /** The discussion link, already checked to be http(s), or null. */
  readonly link: string | null;
}

/** A queued Proposal's id, or why it wasn't queued. */
export type ProposeResult =
  { readonly outcome: 'proposed'; readonly proposalId: string } | { readonly outcome: 'too-large' };

/** One ballot: a score for the Proposal's text and one note, blank for none. */
export interface BallotValues {
  readonly proposal: string;
  readonly score: Score;
  readonly note: string;
}

const nfc = (text: string): string => text.normalize('NFC');

/**
 * Proposes new text for one Atom, as `author` in `groupId`. Every value is
 * NFC-normalized before the event is written. A Proposal too large for any
 * blob is refused before anything is queued.
 */
export async function propose(
  services: ProposalServices,
  groupId: string,
  author: string,
  values: ProposalValues,
): Promise<ProposeResult> {
  const { atom, title, why, text, link } = values;
  const body = {
    atom,
    title: nfc(title),
    why: nfc(why),
    text: nfc(text),
    ...(link === null ? {} : { link: nfc(link) }),
  };
  const event = createEvent({ type: 'proposal', group: groupId, author, ts: services.now(), body });
  if (event.bytes.length > MAX_PLAINTEXT_BYTES) return { outcome: 'too-large' };
  await services.store.enqueue(groupId, event.bytes);
  void services.sync.syncOnce();
  return { outcome: 'proposed', proposalId: event.id };
}

/**
 * Casts `author`'s ballot on one Proposal, scoring its text (version 1, whose
 * id is the Proposal's). A later ballot replaces this one in full until the
 * vote closes. The note is trimmed, and left out when blank.
 */
export async function castBallot(
  services: ProposalServices,
  groupId: string,
  author: string,
  values: BallotValues,
): Promise<void> {
  const { proposal, score } = values;
  const note = nfc(values.note.trim());
  const body = { proposal, scores: { [proposal]: score }, ...(note === '' ? {} : { note }) };
  const event = createEvent({ type: 'vote', group: groupId, author, ts: services.now(), body });
  await services.store.enqueue(groupId, event.bytes);
  void services.sync.syncOnce();
}
