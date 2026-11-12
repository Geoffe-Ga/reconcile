/**
 * What the composer, the ballot and the level picker do (spec §4 and §8),
 * apart from any screen: propose, add a version, ask what to focus on (#107),
 * vote, and choose a level; for stewards (#102), propose a steward or a
 * recall, and suspend; for the opt-ins (#117), propose a rules change, with a
 * steward's narrowing; propose dissolving the group (#108); propose removing a
 * member, and that member's one response (#115); and send a Dispatch (#112).
 *
 * Each action signs one event with this device's key in the group, keeps its
 * record in the store's outbox, and asks the sync loop to send it at once.
 * The key is read from the store here and never handed to a screen. Folded
 * state still comes only from relay records: a Proposal appears, and a ballot
 * counts, once the relay has ordered and timed it.
 */
import { MAX_RECORD_BYTES } from '../crypto/record';
import { newBallotSalt } from '../crypto/salt';
import { type HeadingLevel, normalizeAtomText } from '../engine/atomText';
import type { Level } from '../engine/capabilities';
import {
  type AddTarget,
  base64url,
  type EventDraft,
  type MoveTarget,
  type NewDocumentTarget,
  type ProposalBody,
  type ProposalEventBody,
  type Score,
  type SignedEvent,
  signEvent,
} from '../engine/event';
import type { OptIn, OptInValue } from '../engine/optIns';
import type { Services } from './actions';

/** What the actions here use. */
export type ProposalServices = Pick<Services, 'store' | 'sync' | 'now'>;

/**
 * Where a Proposal goes (#75): the Atom whose text it would replace, where
 * blank text proposes removing the Atom, where a new section goes, a new
 * Document (#92), or a section's new place (#103).
 */
export type ProposalPlace =
  | { readonly atom: string }
  | { readonly target: AddTarget }
  | { readonly target: NewDocumentTarget }
  | { readonly target: MoveTarget };

/** A Proposal's entries: title and why trimmed, the link null when blank. */
export type ProposalValues = ProposalPlace & {
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
  /** The Dispatch to send if it passes (#112), its title and text trimmed; none when absent. */
  readonly dispatch?: DispatchWords;
  /** For an add written as a header (#103), its level, whose draft it was written in. */
  readonly heading?: HeadingLevel;
};

/** A Dispatch's words (#112): its title and text, trimmed and already within their limits. */
export interface DispatchWords {
  readonly title: string;
  readonly text: string;
}

/** The draft target a lapsed Proposal is proposed again from: apart from its Atom's own draft. */
export function againDraft(proposalId: string): string {
  return `again:${proposalId}`;
}

/** The draft key of a removal of Atom `atom`, apart from any change drafted for it (#75). */
export function removalDraft(atom: string): string {
  return `remove:${atom}`;
}

/**
 * The draft key of a new section (#75): after Atom `after`, or, for null,
 * first in the Document `document` (#92), so each Document's start keeps its
 * own draft. A header's (#103) is kept apart from a section's at the same
 * spot, by its level.
 */
export function addDraft(
  { document, after }: Pick<AddTarget, 'document' | 'after'>,
  heading?: HeadingLevel,
): string {
  const spot = after === null ? `add-first:${document}` : `add:${after}`;
  if (heading === undefined) return spot;
  return `${heading === 1 ? 'header' : 'subheader'}:${spot}`;
}

/** The draft key of a move of Atom `atom` (#103), apart from any change drafted for it. */
export function moveDraft(atom: string): string {
  return `move:${atom}`;
}

/** The draft key of a new Document's Proposal (#92): one per group, as the issue names it. */
export const NEW_DOCUMENT_DRAFT = 'new-document';

/**
 * The private draft a Proposal is written in (spec §8): the lapsed
 * Proposal's when proposing again, else its Atom's for a change, the
 * removal's when its text is blank, the add's for its spot, a header's by
 * its level (#103), the move's (#103), or the new Document's (#92).
 */
function draftOf(values: ProposalValues, text: string): string {
  if (values.again !== undefined) return againDraft(values.again);
  if (!('target' in values)) return text === '' ? removalDraft(values.atom) : values.atom;
  const { target } = values;
  if (target.kind === 'move') return moveDraft(target.atom);
  return target.kind === 'add' ? addDraft(target, values.heading) : NEW_DOCUMENT_DRAFT;
}

/**
 * A Proposal's body: where it goes first, its Atom or its target (#75, #92),
 * then its words, in the order every device has signed them. A move carries
 * no text (#103).
 */
function bodyAt(place: ProposalPlace, fields: Omit<ProposalBody, 'atom'>): ProposalEventBody {
  if (!('target' in place)) return { atom: place.atom, ...fields };
  const { target } = place;
  if (target.kind === 'move') {
    const { title, why, link, window, dispatch } = fields;
    return {
      target,
      title,
      why,
      ...(link === undefined ? {} : { link }),
      ...(window === undefined ? {} : { window }),
      ...(dispatch === undefined ? {} : { dispatch }),
    };
  }
  // The branches match on purpose: the check narrows `target`, so each body types as one member of the union.
  return target.kind === 'add' ? { target, ...fields } : { target, ...fields };
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
 * Proposes new text for one Atom, its removal (blank text), a new section
 * (#75), or a new Document (#92), as this device's member of `groupId`, for the voting window the
 * proposer chose, if any (#106). Every string is NFC-normalized before the
 * event is signed, and the text goes through `normalizeAtomText` (spec §4).
 * Queuing the Proposal clears the private draft it was written in in the same
 * change. A Proposal whose record is over 64,000 bytes is refused before
 * anything is queued, and its draft kept.
 *
 * Proposed again (#74), it carries the lapsed Proposal's other versions: one
 * `version` of the new Proposal for each, queued after it in the same change,
 * which clears the draft kept under {@link againDraft} instead.
 *
 * `log` is the id the event names: the group's own, or for a coalition's
 * entry on this device (#120), whose store key is its entry id, the
 * coalition's genesis id, so the motion goes to the coalition's outbox.
 */
export async function propose(
  services: ProposalServices,
  groupId: string,
  values: ProposalValues,
  log: string = groupId,
): Promise<ProposeResult> {
  const { title, why, link, window, versions = [], dispatch } = values;
  const text = normalizeAtomText(values.text);
  const fields = {
    title: nfc(title),
    why: nfc(why),
    text,
    ...(link === null ? {} : { link: nfc(link) }),
    ...(window === undefined ? {} : { window }),
    // Signing NFC-normalizes every string in a body, a Dispatch's too (createEvent).
    ...(dispatch === undefined ? {} : { dispatch }),
  };
  const event = await signFor(services, groupId, {
    type: 'proposal',
    group: log,
    ts: services.now(),
    body: bodyAt(values, fields),
  });
  const others = await Promise.all(
    versions.map((version) =>
      signVersion(services, groupId, { proposal: event.id, text: version }),
    ),
  );
  const events = [event, ...others];
  if (!allFit(events)) return { outcome: 'too-large' };
  await services.store.enqueueAll(
    groupId,
    events.map((signed) => signed.record),
    draftOf(values, text),
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
 * signed, and blank text adds removing the section (#75). Queuing a worded
 * version clears the private draft kept for that Proposal in the same change;
 * a removal has no draft, so it leaves that one alone. A version whose record
 * is over 64,000 bytes is refused before anything is queued, and its draft
 * kept. The fold decides whether it joins the ballot: it ignores one that
 * arrives after the close or past the third.
 */
export async function addVersion(
  services: ProposalServices,
  groupId: string,
  values: VersionValues,
): Promise<AddVersionResult> {
  const event = await signVersion(services, groupId, values);
  if (!allFit([event])) return { outcome: 'too-large' };
  // A removal (blank text) is written in no draft, so it leaves the Proposal's own alone.
  const draft = normalizeAtomText(values.text) === '' ? undefined : values.proposal;
  await services.store.enqueue(groupId, event.record, draft);
  void services.sync.syncOnce();
  return { outcome: 'added', versionId: event.id };
}

/**
 * Casts this device's ballot in `groupId` on one Proposal, scoring each
 * version it names by version id (version 1's id is the Proposal's). A later
 * ballot replaces this one in full until the vote closes, so it carries every
 * score the voter means to keep. The note is trimmed, and left out when blank.
 * Each ballot carries 16 fresh random bytes of salt (#111), which its result's
 * commitment covers, so nobody can test guesses against it once ballots expire.
 */
export async function castBallot(
  services: ProposalServices,
  groupId: string,
  values: BallotValues,
): Promise<void> {
  const { proposal, scores } = values;
  const note = nfc(values.note.trim());
  const salt = base64url(newBallotSalt());
  const body = { proposal, scores, ...(note === '' ? {} : { note }), salt };
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

/** A dissolve Proposal's entries (#108): title and why, trimmed, the window chosen, and whether to wipe. */
export interface DissolveValues {
  readonly title: string;
  readonly why: string;
  /** How many whole days voting runs, already checked against the entrenched bounds. */
  readonly window: number;
  /** Whether every device also erases the group, a week after it dissolves. */
  readonly wipe: boolean;
}

/**
 * Proposes dissolving `groupId` (ADR-0051, #108), as this device's member,
 * for the window chosen and with or without a wipe. The title and why are
 * NFC-normalized before signing. One too large for any blob is refused before
 * anything is queued. The fold decides whether it opens: it ignores one while
 * another is open.
 */
export async function proposeDissolve(
  services: ProposalServices,
  groupId: string,
  values: DissolveValues,
): Promise<ProposeResult> {
  const body = {
    target: { kind: 'dissolve', wipe: values.wipe } as const,
    title: nfc(values.title),
    why: nfc(values.why),
    window: values.window,
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

/** A removal's entries (#115): whom it would remove, and title and why, trimmed. */
export interface RemovalValues {
  /** The key of the member it would remove. */
  readonly member: string;
  readonly title: string;
  readonly why: string;
}

/**
 * Proposes removing a member of `groupId` (ADR-0049, #115), as this device's
 * member. It carries no window: a removal runs a fixed 14 days (ADR-0075 §3).
 * The title and why are NFC-normalized before signing. One too large for any
 * blob is refused before anything is queued. The fold decides whether it
 * opens: it ignores one while another removal of that member is open.
 */
export async function proposeRemoval(
  services: ProposalServices,
  groupId: string,
  values: RemovalValues,
): Promise<ProposeResult> {
  const body = {
    target: { kind: 'remove', member: values.member } as const,
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

/**
 * Posts this device's member's one response on the removal of them,
 * `proposal` (ADR-0049, #115). The text is trimmed and NFC-normalized before
 * signing, and the fold counts its code points: 1 to 1,000.
 */
export async function respondToRemoval(
  services: ProposalServices,
  groupId: string,
  values: { readonly proposal: string; readonly text: string },
): Promise<void> {
  const body = { proposal: values.proposal, text: nfc(values.text.trim()) };
  const event = await signFor(services, groupId, {
    type: 'removal-response',
    group: groupId,
    ts: services.now(),
    body,
  });
  await services.store.enqueue(groupId, event.record);
  void services.sync.syncOnce();
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

/** A rules Proposal's entries: the opt-in and the value it would set, title and why trimmed. */
export interface RulesValues {
  readonly optIn: OptIn;
  /** The value, already checked by the opt-in's validator (src/engine/optIns.ts). */
  readonly value: OptInValue;
  readonly title: string;
  readonly why: string;
  /** True for a steward's Turn off now: a `narrow` naming the Proposal follows it. */
  readonly narrow: boolean;
  /**
   * How many whole days voting runs, already checked against the bounds of
   * the change's class (#106). Absent, the Proposal runs the class default.
   */
  readonly window?: number;
}

/**
 * Proposes setting an opt-in (ADR-0040, #117), as this device's member of
 * `groupId`, for the voting window the proposer chose, if any. The title and
 * why are NFC-normalized before signing. For Turn
 * off now, a `narrow` naming the new Proposal follows it in the same store
 * change, so the relay receives the Proposal first. Either one too large for
 * any blob is refused before anything is queued. The fold decides whether
 * each holds. The webhook goes only into the sealed event (spec §9).
 */
export async function proposeRules(
  services: ProposalServices,
  groupId: string,
  values: RulesValues,
): Promise<ProposeResult> {
  const { optIn, value, window } = values;
  const body = {
    target: { kind: 'rules', optIn, value } as const,
    title: nfc(values.title),
    why: nfc(values.why),
    ...(window === undefined ? {} : { window }),
  };
  const ts = services.now();
  const event = await signFor(services, groupId, { type: 'proposal', group: groupId, ts, body });
  const narrowed = values.narrow
    ? [
        await signFor(services, groupId, {
          type: 'narrow',
          group: groupId,
          ts,
          body: { optIn, proposal: event.id },
        }),
      ]
    : [];
  const events = [event, ...narrowed];
  if (!allFit(events)) return { outcome: 'too-large' };
  await services.store.enqueueAll(
    groupId,
    events.map((signed) => signed.record),
  );
  void services.sync.syncOnce();
  return { outcome: 'proposed', proposalId: event.id };
}

/**
 * Vouches for the newcomer named (ADR-0014, #101), as this device's member of
 * `groupId`. The vouch counts from the relay's receipt, and the fold decides
 * whether it holds.
 */
export async function vouch(
  services: ProposalServices,
  groupId: string,
  member: string,
): Promise<void> {
  const event = await signFor(services, groupId, {
    type: 'vouch',
    group: groupId,
    ts: services.now(),
    body: { member },
  });
  await services.store.enqueue(groupId, event.record);
  void services.sync.syncOnce();
}

/** A Dispatch's entries (#112): its title and text, trimmed, and the Document it points to, or null. */
export interface DispatchValues extends DispatchWords {
  readonly doc: string | null;
}

/**
 * Sends a Dispatch to the whole group (#112), as this device's member of
 * `groupId`: its title and text, which signing NFC-normalizes (createEvent),
 * and its Document, when one is chosen. Within its limits a Dispatch is a few
 * kilobytes at most, so it always fits a blob. Its PUT wakes the group's
 * phones (`wakeFor`), and the fold decides whether it holds: only a
 * Co-Creator's does. Resolves to the queued Dispatch's id.
 */
export async function sendDispatch(
  services: ProposalServices,
  groupId: string,
  values: DispatchValues,
): Promise<string> {
  const { title, text, doc } = values;
  const body = { title, text, ...(doc === null ? {} : { doc }) };
  const event = await signFor(services, groupId, {
    type: 'dispatch',
    group: groupId,
    ts: services.now(),
    body,
  });
  await services.store.enqueue(groupId, event.record);
  void services.sync.syncOnce();
  return event.id;
}
