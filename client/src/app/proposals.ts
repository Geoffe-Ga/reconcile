/**
 * What the composer, the ballot and the level picker do (spec §4 and §8),
 * apart from any screen: propose, add a version, vote, and choose a level.
 *
 * Each action signs one event with this device's key in the group, keeps its
 * record in the store's outbox, and asks the sync loop to send it at once.
 * The key is read from the store here and never handed to a screen. Folded
 * state still comes only from relay records: a Proposal appears, and a ballot
 * counts, once the relay has ordered and timed it.
 */
import { MAX_PLAINTEXT_BYTES } from '../crypto/seal';
import { normalizeAtomText } from '../engine/atomText';
import type { Level } from '../engine/capabilities';
import {
  type AddTarget,
  type EventDraft,
  type Score,
  type SignedEvent,
  signEvent,
} from '../engine/event';
import type { Services } from './actions';

/** What the actions here use. */
export type ProposalServices = Pick<Services, 'store' | 'sync' | 'now'>;

/**
 * Where a Proposal goes (#75): the Atom whose text it would replace, where
 * blank text proposes removing the Atom, or where a new section goes.
 */
export type ProposalPlace = { readonly atom: string } | { readonly target: AddTarget };

/** A Proposal's entries: title and why trimmed, the link null when blank. */
export type ProposalValues = ProposalPlace & {
  readonly title: string;
  readonly why: string;
  /** The proposed text, as typed; `propose` normalizes it. */
  readonly text: string;
  /** The discussion link, already checked to be http(s), or null. */
  readonly link: string | null;
};

/** The draft key of a removal of Atom `atom`, apart from any change drafted for it (#75). */
export function removalDraft(atom: string): string {
  return `remove:${atom}`;
}

/** The draft key of a new section after Atom `after`, or first for null (#75). */
export function addDraft(after: string | null): string {
  return `add:${after ?? ''}`;
}

/**
 * The private draft a Proposal is written in (spec §8): its Atom's for a
 * change, the removal's when its text is blank, or the add's for its spot.
 */
function draftOf(values: ProposalValues, text: string): string {
  if ('target' in values) return addDraft(values.target.after);
  return text === '' ? removalDraft(values.atom) : values.atom;
}

/** A queued Proposal's id, or why it wasn't queued. */
export type ProposeResult =
  { readonly outcome: 'proposed'; readonly proposalId: string } | { readonly outcome: 'too-large' };

/** A version's entries: the Proposal it joins, and its text as typed. */
export interface VersionValues {
  readonly proposal: string;
  /** The version's text, as typed; `addVersion` normalizes it. */
  readonly text: string;
}

/** A queued version's id, or why it wasn't queued. */
export type AddVersionResult =
  { readonly outcome: 'added'; readonly versionId: string } | { readonly outcome: 'too-large' };

/** One ballot: a score for each version, keyed by version id, and one note, blank for none. */
export interface BallotValues {
  readonly proposal: string;
  readonly scores: Readonly<Record<string, Score>>;
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
 * Proposes new text for one Atom, its removal (blank text), or a new section
 * (#75), as this device's member of `groupId`. Every value is NFC-normalized
 * before the event is signed, and the text goes through `normalizeAtomText`
 * (spec §4). Queuing the Proposal clears the private draft it was written in
 * in the same change. A Proposal whose record is too large for any blob is
 * refused before anything is queued, and its draft kept.
 */
export async function propose(
  services: ProposalServices,
  groupId: string,
  values: ProposalValues,
): Promise<ProposeResult> {
  const { title, why, link } = values;
  const text = normalizeAtomText(values.text);
  const place = 'target' in values ? { target: values.target } : { atom: values.atom };
  const body = {
    ...place,
    title: nfc(title),
    why: nfc(why),
    text,
    ...(link === null ? {} : { link: nfc(link) }),
  };
  const event = await signFor(services, groupId, {
    type: 'proposal',
    group: groupId,
    ts: services.now(),
    body,
  });
  if (event.record.length > MAX_PLAINTEXT_BYTES) return { outcome: 'too-large' };
  await services.store.enqueue(groupId, event.record, draftOf(values, text));
  void services.sync.syncOnce();
  return { outcome: 'proposed', proposalId: event.id };
}

/**
 * Adds a version to an open Proposal's ballot (ADR-0004), as this device's
 * member of `groupId`. The text goes through `normalizeAtomText` before it is
 * signed, and blank text adds removing the section (#75). Queuing a worded
 * version clears the private draft kept for that Proposal in the same change;
 * a removal has no draft, so it leaves that one alone. A version too large
 * for any blob is refused before anything is queued, and its draft kept. The
 * fold decides whether it joins the ballot: it ignores one that arrives after
 * the close or past the third.
 */
export async function addVersion(
  services: ProposalServices,
  groupId: string,
  values: VersionValues,
): Promise<AddVersionResult> {
  const { proposal } = values;
  const body = { proposal, text: normalizeAtomText(values.text) };
  const event = await signFor(services, groupId, {
    type: 'version',
    group: groupId,
    ts: services.now(),
    body,
  });
  if (event.record.length > MAX_PLAINTEXT_BYTES) return { outcome: 'too-large' };
  await services.store.enqueue(groupId, event.record, body.text === '' ? undefined : proposal);
  void services.sync.syncOnce();
  return { outcome: 'added', versionId: event.id };
}

/**
 * Casts this device's ballot in `groupId` on one Proposal, scoring each
 * version it names by version id (version 1's id is the Proposal's). A later
 * ballot replaces this one in full until the vote closes, so it carries every
 * score the voter means to keep. The note is trimmed, and left out when blank.
 */
export async function castBallot(
  services: ProposalServices,
  groupId: string,
  values: BallotValues,
): Promise<void> {
  const { proposal, scores } = values;
  const note = nfc(values.note.trim());
  const body = { proposal, scores, ...(note === '' ? {} : { note }) };
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
