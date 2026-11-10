/**
 * What the composer, the ballot and the level picker do (spec §4 and §8),
 * apart from any screen: propose, add a version, ask what to focus on (#107),
 * vote, and choose a level; and for stewards (#102), propose a steward or a
 * recall, and suspend.
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
  /**
   * How many whole days voting runs, already checked against the bounds of
   * the target's class (#106). Absent, the Proposal runs the class default.
   */
  readonly window?: number;
  /** Proposing a lapsed Proposal again (#74): that Proposal's id, whose draft this was written in. */
  readonly again?: string;
  /** The texts of the other versions to put on its ballot after it, as typed, in order. */
  readonly versions?: readonly string[];
}

/** The draft target a lapsed Proposal is proposed again from: apart from its Atom's own draft. */
export function againDraft(proposalId: string): string {
  return `again:${proposalId}`;
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

/** A priority vote's entries (#107): the question and why, trimmed, and each option as typed. */
export interface PriorityValues {
  readonly title: string;
  readonly why: string;
  /** The options in ballot order, as typed; `askPriority` normalizes each with {@link optionText}. */
  readonly options: readonly string[];
  /** How many whole days voting runs, already checked against its class's bounds (#106). */
  readonly window?: number;
}

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

/** One `version` of `proposal`, its text normalized as Atom text, signed by this device's member. */
function signVersion(
  services: ProposalServices,
  groupId: string,
  values: VersionValues,
): Promise<SignedEvent> {
  const body = { proposal: values.proposal, text: normalizeAtomText(values.text) };
  return signFor(services, groupId, { type: 'version', group: groupId, ts: services.now(), body });
}

/** True when no record is over 64,000 bytes, so each fits in a blob and an invite chunk. */
function allFit(events: readonly SignedEvent[]): boolean {
  return events.every((event) => event.record.length <= MAX_RECORD_BYTES);
}

/**
 * Proposes new text for one Atom, as this device's member of `groupId`, for
 * the voting window the proposer chose, if any. Every string is
 * NFC-normalized before the event is signed, and the text goes through
 * `normalizeAtomText` (spec §4). Queuing the Proposal clears the
 * private draft it was written in, keyed by its Atom, in the same change. A
 * Proposal whose record is over 64,000 bytes is refused before anything is
 * queued, and its draft kept.
 *
 * Proposed again (#74), it carries the lapsed Proposal's other versions: one
 * `version` of the new Proposal for each, queued after it in the same change,
 * which clears the draft kept under {@link againDraft} instead.
 */
export async function propose(
  services: ProposalServices,
  groupId: string,
  values: ProposalValues,
): Promise<ProposeResult> {
  const { atom, title, why, text, link, window, again, versions = [] } = values;
  const body = {
    atom,
    title: nfc(title),
    why: nfc(why),
    text: normalizeAtomText(text),
    ...(link === null ? {} : { link: nfc(link) }),
    ...(window === undefined ? {} : { window }),
  };
  const event = await signFor(services, groupId, {
    type: 'proposal',
    group: groupId,
    ts: services.now(),
    body,
  });
  const others = await Promise.all(
    versions.map((version) =>
      signVersion(services, groupId, { proposal: event.id, text: version }),
    ),
  );
  const events = [event, ...others];
  if (!allFit(events)) return { outcome: 'too-large' };
  const draft = again === undefined ? atom : againDraft(again);
  await services.store.enqueueAll(
    groupId,
    events.map((signed) => signed.record),
    draft,
  );
  void services.sync.syncOnce();
  return { outcome: 'proposed', proposalId: event.id };
}

/**
 * A priority option as it is signed: NFC-normalized, then trimmed, which is
 * how the composer checks it too (spec §4). The fold never re-normalizes it.
 */
export function optionText(option: string): string {
  return nfc(option).trim();
}

/**
 * Asks the group what to focus on (#107), as this device's member of
 * `groupId`: one `proposal` whose target is `{kind: "priority"}`, its title the
 * question, with the options in order. The fold ignores it unless there are
 * 2–7 distinct options of 1–120 code points and no other priority vote is
 * open, which the composer checks first, for the voting window the asker
 * chose, if any (#106). It keeps no draft. A record over
 * 64,000 bytes is refused before anything is queued.
 */
export async function askPriority(
  services: ProposalServices,
  groupId: string,
  values: PriorityValues,
): Promise<ProposeResult> {
  const { window } = values;
  const body = {
    target: { kind: 'priority' } as const,
    title: nfc(values.title),
    why: nfc(values.why),
    options: values.options.map(optionText),
    ...(window === undefined ? {} : { window }),
  };
  const event = await signFor(services, groupId, {
    type: 'proposal',
    group: groupId,
    ts: services.now(),
    body,
  });
  if (!allFit([event])) return { outcome: 'too-large' };
  await services.store.enqueue(groupId, event.record);
  void services.sync.syncOnce();
  return { outcome: 'proposed', proposalId: event.id };
}

/**
 * Adds a version to an open Proposal's ballot (ADR-0004), as this device's
 * member of `groupId`. The text goes through `normalizeAtomText` before it is
 * signed. Queuing it clears the private draft kept for that Proposal in the
 * same change. A version whose record is over 64,000 bytes is refused before
 * anything is queued, and its draft kept. The fold decides whether it joins the ballot:
 * it ignores one that arrives after the close or past the third.
 */
export async function addVersion(
  services: ProposalServices,
  groupId: string,
  values: VersionValues,
): Promise<AddVersionResult> {
  const event = await signVersion(services, groupId, values);
  if (!allFit([event])) return { outcome: 'too-large' };
  await services.store.enqueue(groupId, event.record, values.proposal);
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

/** A steward Proposal's entries: the seat, the nominee (null for a recall), and title and why, trimmed. */
export interface StewardValues {
  readonly seat: number;
  readonly member: string | null;
  readonly title: string;
  readonly why: string;
}

/**
 * Proposes electing the nominee to `seat`, or recalling its steward when
 * there is none (ADR-0049, #102), as this device's member of `groupId`.
 * The title and why are NFC-normalized before signing. One too large for any
 * blob is refused before anything is queued. The fold decides whether it
 * opens: it ignores one the seat or the group's size doesn't allow.
 */
export async function proposeSteward(
  services: ProposalServices,
  groupId: string,
  values: StewardValues,
): Promise<ProposeResult> {
  const { seat, member } = values;
  const body = {
    target: { kind: 'steward', seat, member } as const,
    title: nfc(values.title),
    why: nfc(values.why),
  };
  const event = await signFor(services, groupId, {
    type: 'proposal',
    group: groupId,
    ts: services.now(),
    body,
  });
  if (!allFit([event])) return { outcome: 'too-large' };
  await services.store.enqueue(groupId, event.record);
  void services.sync.syncOnce();
  return { outcome: 'proposed', proposalId: event.id };
}

/** A suspension's entries: the member it suspends, and the reason as typed, blank for none. */
export interface SuspendValues {
  readonly member: string;
  readonly reason: string;
}

/**
 * Suspends the member named (ADR-0016, #102), as this device's steward in `groupId`.
 * The reason is trimmed and NFC-normalized, and left out when blank. The
 * suspension starts when the relay receives it, and the fold decides whether
 * it holds.
 */
export async function suspend(
  services: ProposalServices,
  groupId: string,
  values: SuspendValues,
): Promise<void> {
  const reason = nfc(values.reason.trim());
  const body = { member: values.member, ...(reason === '' ? {} : { reason }) };
  const event = await signFor(services, groupId, {
    type: 'suspend',
    group: groupId,
    ts: services.now(),
    body,
  });
  await services.store.enqueue(groupId, event.record);
  void services.sync.syncOnce();
}
