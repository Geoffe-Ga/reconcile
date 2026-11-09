/**
 * The group fold (docs/spec/phase-1-spec.md §4): a mailbox's records, in relay
 * order, become one `GroupState`.
 *
 * Every rule is checked against the state before the event. An event that
 * breaks one lands in `ignored` and changes nothing. Votes run on relay time
 * (`received`, in whole minutes); the author's `ts` plays no part. A Document's
 * text changes only when a Proposal's pass is final. The fold is pure: no I/O,
 * no clock, no randomness, so every device that folds the same records builds
 * the same state.
 */
import { can, type Level, MVP_LEVEL } from './capabilities';
import {
  EVENT_VERSION,
  type GenesisBody,
  type GroupEvent,
  type JoinBody,
  parseRecord,
  type ProposalBody,
  type Score,
  type VoteBody,
} from './event';
import { tally, type TallyOutcome } from './tally';
import { codePointLength } from './text';

/** How long a vote runs: 7 days of relay minutes from the relay's receipt of the Proposal. */
export const VOTE_WINDOW_MINUTES = 10_080;
/** The longest Proposal title, in code points. */
export const TITLE_MAX = 120;
/** The longest justification, in code points. */
export const WHY_MAX = 2_000;
/** The longest ballot note, in code points. */
export const NOTE_MAX = 280;

/**
 * One record as the relay returned it: its seq, its receipt minute and the
 * signed record's bytes, `publicKey ‖ signature ‖ event bytes` (spec §3).
 */
export interface LogRecord {
  readonly seq: number;
  readonly received: number;
  readonly bytes: Uint8Array;
}

/** A member, with the name fixed at join and the seq of the event that admitted them. */
export interface Member {
  readonly author: string;
  readonly name: string;
  readonly level: Level;
  readonly seq: number;
}

/** A unit of the Document. Genesis Atom `i` has the id `${genesisId}.${i}`. */
export interface Atom {
  readonly id: string;
  readonly documentId: string;
  readonly text: string;
}

/** One wording on a Proposal's ballot. A Proposal's own text is its first version. */
export interface Version {
  readonly id: string;
  readonly author: string;
  readonly text: string;
}

/** A voter's latest valid ballot on one Proposal. */
export interface Ballot {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly voter: string;
  readonly scores: Readonly<Record<string, Score>>;
  readonly note: string | null;
}

/**
 * A proposed change to one Atom, with its vote.
 *
 * `eligible` is who could vote when it opened (ADR-0015). `closedAt` is the
 * receipt minute of the ballot that closed it early, or null. `final` is true
 * once it has closed, early or because relay time reached `deadline`. `outcome`
 * is the tally of the ballots so far, and is settled only when `final`.
 */
export interface Proposal {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly author: string;
  readonly atom: string;
  readonly title: string;
  readonly why: string;
  readonly text: string;
  readonly link: string | null;
  readonly deadline: number;
  readonly eligible: readonly string[];
  readonly versions: readonly Version[];
  readonly ballots: readonly Ballot[];
  readonly closedAt: number | null;
  readonly final: boolean;
  readonly outcome: TallyOutcome;
}

/**
 * A record the fold left out: a repeat, bad bytes, or an event that broke a
 * rule. `id` is null when the record didn't verify, doesn't hold an event, or
 * names an author other than the key that signed it: such bytes have no
 * trustworthy event id.
 */
export interface IgnoredRecord {
  readonly seq: number;
  readonly id: string | null;
}

/** A group as one device sees it after folding its log. `group` is the genesis id, or null before one. */
export interface GroupState {
  readonly group: string | null;
  readonly name: string;
  readonly chat: string | null;
  readonly title: string;
  readonly members: readonly Member[];
  readonly atoms: readonly Atom[];
  readonly proposals: readonly Proposal[];
  readonly ignored: readonly IgnoredRecord[];
}

/** Where an event sits in the relay's log. */
interface Receipt {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
}

/** A Proposal while the fold runs: its ballots and early close still change. */
interface OpenProposal extends Omit<Proposal, 'ballots' | 'closedAt' | 'final' | 'outcome'> {
  ballots: Ballot[];
  closedAt: number | null;
}

/** The state the fold builds up, one event at a time. */
interface Draft {
  group: string | null;
  name: string;
  chat: string | null;
  title: string;
  readonly members: Member[];
  atoms: Atom[];
  readonly proposals: OpenProposal[];
}

function applyGenesis(draft: Draft, body: GenesisBody, author: string, at: Receipt): boolean {
  draft.group = at.id;
  draft.name = body.name;
  draft.chat = body.chat ?? null;
  draft.title = body.title;
  draft.members.push({ author, name: body.founder, level: MVP_LEVEL, seq: at.seq });
  draft.atoms = body.atoms.map((text, i) => ({
    id: `${at.id}.${String(i)}`,
    documentId: at.id,
    text,
  }));
  return true;
}

function applyJoin(draft: Draft, body: JoinBody, author: string, at: Receipt): boolean {
  if (draft.members.some((m) => m.author === author)) return false;
  draft.members.push({ author, name: body.name, level: MVP_LEVEL, seq: at.seq });
  return true;
}

function proposalIsValid(draft: Draft, body: ProposalBody, author: string): boolean {
  const titleLength = codePointLength(body.title);
  return (
    can(draft, author, 'propose') &&
    draft.atoms.some((a) => a.id === body.atom) &&
    titleLength >= 1 &&
    titleLength <= TITLE_MAX &&
    codePointLength(body.why) <= WHY_MAX
  );
}

function applyProposal(draft: Draft, body: ProposalBody, author: string, at: Receipt): boolean {
  if (!proposalIsValid(draft, body, author)) return false;
  draft.proposals.push({
    ...at,
    author,
    atom: body.atom,
    title: body.title,
    why: body.why,
    text: body.text,
    link: body.link ?? null,
    deadline: at.received + VOTE_WINDOW_MINUTES,
    eligible: draft.members.filter((m) => can(draft, m.author, 'vote')).map((m) => m.author),
    versions: [{ id: at.id, author, text: body.text }],
    ballots: [],
    closedAt: null,
  });
  return true;
}

/** At least one score, and every score names a version on the Proposal. */
function scoresAreKnown(proposal: OpenProposal, scores: VoteBody['scores']): boolean {
  const named = Object.keys(scores);
  return named.length > 0 && named.every((id) => proposal.versions.some((v) => v.id === id));
}

/** At most 280 code points, and not blank when any score is 0. */
function noteIsValid(body: VoteBody): boolean {
  const note = body.note ?? '';
  const needsReason = Object.values(body.scores).includes(0);
  return codePointLength(note) <= NOTE_MAX && (!needsReason || note.trim() !== '');
}

/** The ballot's rules: an eligible voter holding `vote`, known versions, a valid note, in time. */
function ballotIsValid(
  draft: Draft,
  proposal: OpenProposal,
  body: VoteBody,
  author: string,
  at: Receipt,
): boolean {
  return (
    proposal.eligible.includes(author) &&
    can(draft, author, 'vote') &&
    scoresAreKnown(proposal, body.scores) &&
    noteIsValid(body) &&
    at.received < proposal.deadline &&
    proposal.closedAt === null
  );
}

/** True when every eligible member's latest ballot scores every version. */
function everyoneHasScored(proposal: OpenProposal): boolean {
  return proposal.eligible.every((voter) => {
    const ballot = proposal.ballots.find((b) => b.voter === voter);
    return (
      ballot !== undefined && proposal.versions.every((v) => Object.hasOwn(ballot.scores, v.id))
    );
  });
}

function applyVote(draft: Draft, body: VoteBody, author: string, at: Receipt): boolean {
  const proposal = draft.proposals.find((p) => p.id === body.proposal);
  if (proposal === undefined || !ballotIsValid(draft, proposal, body, author, at)) return false;
  const ballot = { ...at, voter: author, scores: body.scores, note: body.note ?? null };
  proposal.ballots = [...proposal.ballots.filter((b) => b.voter !== author), ballot];
  if (everyoneHasScored(proposal)) proposal.closedAt = at.received;
  return true;
}

/** Genesis must carry `""` and come first; every other event must carry the genesis id. */
function inGroup(draft: Draft, event: GroupEvent): boolean {
  return event.type === 'genesis'
    ? draft.group === null && event.group === ''
    : event.group === draft.group;
}

/** Applies one verified event to the draft, or returns false to ignore it. */
function applyEvent(draft: Draft, event: GroupEvent, at: Receipt): boolean {
  if (event.v !== EVENT_VERSION || !inGroup(draft, event)) return false;
  switch (event.type) {
    case 'genesis':
      return applyGenesis(draft, event.body, event.author, at);
    case 'join':
      return applyJoin(draft, event.body, event.author, at);
    case 'proposal':
      return applyProposal(draft, event.body, event.author, at);
    case 'vote':
      return applyVote(draft, event.body, event.author, at);
  }
}

/** Every score the ballots gave version `id`, one per ballot that scored it. */
function scoresFor(ballots: readonly Ballot[], id: string): Score[] {
  return ballots.flatMap((b) =>
    Object.entries(b.scores)
      .filter(([version]) => version === id)
      .map(([, score]) => score),
  );
}

/** Fixes a Proposal's finality and tallies its ballots. */
function settle(proposal: OpenProposal, relayNow: number | null): Proposal {
  const final = proposal.closedAt !== null || (relayNow !== null && relayNow >= proposal.deadline);
  const outcome = tally({
    eligible: proposal.eligible.length,
    versions: proposal.versions.map((v) => ({
      id: v.id,
      scores: scoresFor(proposal.ballots, v.id),
    })),
  });
  return { ...proposal, final, outcome };
}

/** The `[atom, text]` a Proposal sets: its winning version's text once its pass is final, else none. */
function finalUpdate(proposal: Proposal): [string, string][] {
  if (!proposal.final || proposal.outcome.kind !== 'pass') return [];
  const winner = proposal.outcome.version;
  return proposal.versions.filter((v) => v.id === winner).map((v) => [proposal.atom, v.text]);
}

/** When a closed Proposal closed: early, or at its deadline. */
function closeTime(proposal: Proposal): number {
  return proposal.closedAt ?? proposal.deadline;
}

/** Applies final passes to the Atoms in order of close time, then the Proposals' relay order. */
function applyPasses(atoms: readonly Atom[], proposals: readonly Proposal[]): readonly Atom[] {
  // `proposals` is in relay order and sort is stable, so equal close times keep relay order.
  const byClose = [...proposals].sort((a, b) => closeTime(a) - closeTime(b));
  // A later entry for the same Atom replaces an earlier one, so the last pass to close wins.
  const texts = new Map(byClose.flatMap(finalUpdate));
  return atoms.map((atom) => {
    const text = texts.get(atom.id);
    return text === undefined ? atom : { ...atom, text };
  });
}

/**
 * Folds a group's records, in relay order, into its state.
 *
 * `relayNow` is the relay's latest `now`, in minutes, or null before the first
 * sync; it decides only which Proposals have reached their deadline. A record
 * that doesn't verify, or whose event's `author` isn't the key that signed it,
 * is ignored before it is parsed or claims an event id, so a forged copy of a
 * real event can never shadow it. A repeated event id is ignored (the first
 * copy keeps its seq and receipt time), as is any event whose `v` isn't 1 or
 * whose `group` isn't the genesis id. Only members act, except on their own
 * join: `can()` is false for anyone else.
 */
export function fold(records: readonly LogRecord[], relayNow: number | null): GroupState {
  const draft: Draft = {
    group: null,
    name: '',
    chat: null,
    title: '',
    members: [],
    atoms: [],
    proposals: [],
  };
  const ignored: IgnoredRecord[] = [];
  const seen = new Set<string>();
  for (const { seq, received, bytes } of records) {
    const parsed = parseRecord(bytes);
    if (parsed === null) {
      ignored.push({ seq, id: null });
      continue;
    }
    const { event, id } = parsed;
    const applied = !seen.has(id) && applyEvent(draft, event, { id, seq, received });
    seen.add(id);
    if (!applied) ignored.push({ seq, id });
  }
  const proposals = draft.proposals.map((p) => settle(p, relayNow));
  const atoms = applyPasses(draft.atoms, proposals);
  const { group, name, chat, title, members } = draft;
  return { group, name, chat, title, members, atoms, proposals, ignored };
}
