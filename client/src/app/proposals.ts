/**
 * What the composer, the ballot and the level picker do (spec §4 and §8),
 * apart from any screen.
 *
 * Each action signs one event with this device's key in the group, keeps its
 * record in the store's outbox, and asks the sync loop to send it at once.
 * The key is read from the store here and never handed to a screen. Folded
 * state still comes only from relay records: a Proposal appears, and a ballot
 * counts, once the relay has ordered and timed it.
 */
import { MAX_RECORD_BYTES } from '../crypto/record';
import { normalizeAtomText } from '../engine/atomText';
import type { Level } from '../engine/capabilities';
import { type EventDraft, type Score, type SignedEvent, signEvent } from '../engine/event';
import type { Services } from './actions';

/** What the actions here use. */
export type ProposalServices = Pick<Services, 'store' | 'sync' | 'now'>;

/** A Proposal's entries: title and why trimmed, the link null when blank. */
export interface ProposalValues {
  /** The Atom whose text it would replace. */
  readonly atom: string;
  readonly title: string;
  readonly why: string;
  /** The proposed text, as typed; `propose` normalizes it. */
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

/** `draft`, signed with this device's key in `groupId`. */
async function signFor(
  services: ProposalServices,
  groupId: string,
  draft: EventDraft,
): Promise<SignedEvent> {
  const group = await services.store.getGroup(groupId);
  if (group === undefined) throw new Error('No such group on this device.');
  return signEvent(group.signingKey, draft);
}

/**
 * Proposes new text for one Atom, as this device's member of `groupId`. Every
 * value is NFC-normalized before the event is signed, and the text goes
 * through `normalizeAtomText` (spec §4). Queuing the Proposal clears the
 * private draft it was written in, keyed by its Atom, in the same change. A
 * Proposal whose record is over 64,000 bytes is refused before anything is
 * queued, and its draft kept.
 */
export async function propose(
  services: ProposalServices,
  groupId: string,
  values: ProposalValues,
): Promise<ProposeResult> {
  const { atom, title, why, text, link } = values;
  const body = {
    atom,
    title: nfc(title),
    why: nfc(why),
    text: normalizeAtomText(text),
    ...(link === null ? {} : { link: nfc(link) }),
  };
  const event = await signFor(services, groupId, {
    type: 'proposal',
    group: groupId,
    ts: services.now(),
    body,
  });
  if (event.record.length > MAX_RECORD_BYTES) return { outcome: 'too-large' };
  await services.store.enqueue(groupId, event.record, atom);
  void services.sync.syncOnce();
  return { outcome: 'proposed', proposalId: event.id };
}

/**
 * Casts this device's ballot in `groupId` on one Proposal, scoring its text
 * (version 1, whose id is the Proposal's). A later ballot replaces this one in
 * full until the vote closes. The note is trimmed, and left out when blank.
 */
export async function castBallot(
  services: ProposalServices,
  groupId: string,
  values: BallotValues,
): Promise<void> {
  const { proposal, score } = values;
  const note = nfc(values.note.trim());
  const body = { proposal, scores: { [proposal]: score }, ...(note === '' ? {} : { note }) };
  const event = await signFor(services, groupId, {
    type: 'vote',
    group: groupId,
    ts: services.now(),
    body,
  });
  await services.store.enqueue(groupId, event.record);
  void services.sync.syncOnce();
}

/**
 * Moves this device's member of `groupId` to `level` (ADR-0021: self-selected).
 * The new level holds from the relay's receipt of the event on, and never
 * changes a Proposal that's already open.
 */
export async function chooseLevel(
  services: ProposalServices,
  groupId: string,
  level: Level,
): Promise<void> {
  const event = await signFor(services, groupId, {
    type: 'level',
    group: groupId,
    ts: services.now(),
    body: { level },
  });
  await services.store.enqueue(groupId, event.record);
  void services.sync.syncOnce();
}
