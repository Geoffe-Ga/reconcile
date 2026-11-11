/**
 * A section's history and a Document's change log (#104; docs/spec/phase-1-spec.md
 * §8, Document view; ADR-0010, ADR-0017, ADR-0036, ADR-0069).
 *
 * Everything here is worked out on the device from the log the group already
 * holds: no new event, and nothing sent. It replays the final passes in the
 * order the fold applies them, by close time and then relay order, from each
 * section's founding text (`GroupState.founding`), so every entry's text is
 * what its section read right after that decision, and a removed section
 * keeps its history. A pass carries its winning version's author and totals,
 * never a ballot or a voter's name (ADR-0010 keeps those to the result), so a
 * history reads the same before and after #111 clears the ballots: a cleared
 * Proposal's totals come from its result's counts (`proposalTally`), and a
 * cleared archive's from the tallies it kept (#108). A coalition's motions
 * are decided by its groups, so a passed motion carries each group's pass or
 * fail and no totals, as its result does (ADR-0036). Priority, steward,
 * rules, dissolve, reconcile and admit Proposals change no section, so none
 * of them appears. `describeChange` says what a pass did as data; the
 * screens put it into words, since src/engine imports no app code.
 */
import { RESULT_GRACE_MINUTES } from './coalition';
import { coalitionProgress, type GroupStanding } from './coalitionProgress';
import { documentOf, documentSections } from './documents';
import { closeTime, type GroupState, type Proposal, proposalTally, type Version } from './fold';
import type { ProposalTarget } from './stewards';
import type { TallyDetail, VersionTotals } from './tally';

/**
 * What a decision did to a Document, as data. A Document's founding text was
 * `founded` with its group (or coalition), and a passed new Document
 * `created` it (#92). A pass `added` a section (#75), `changed` one's text,
 * or `removed` it, and `quote` is that section's text as it read before, for
 * the screens to quote its first words.
 */
export type Change =
  | { readonly kind: 'founded' }
  | { readonly kind: 'created' }
  | { readonly kind: 'added' }
  | { readonly kind: 'changed'; readonly quote: string }
  | { readonly kind: 'removed'; readonly quote: string };

/** What a Proposal's pass did: any {@link Change} but a founding. */
export type PassChange = Exclude<Change, { readonly kind: 'founded' }>;

/**
 * One decision that shaped a section: a final pass, or its founding text.
 * `proposalId`, `title` and `why` are null for the founding text. `decidedAt`
 * is the relay minute it took effect: the Proposal's close (its early close
 * or its deadline), a coalition motion's when the coalition decided it, or
 * the genesis's receipt for the founding text. `text`
 * is the section's text right after, the winning version's, or `""` once
 * removed. `author` wrote that text: the winning version's author, the
 * founder for the founding text, or null for a coalition's founding text.
 * `totals` are the winning version's, and `groups` each group's pass or fail
 * on a coalition motion, in seat order; each is null where it doesn't apply.
 */
export interface PassedChange {
  readonly proposalId: string | null;
  readonly title: string | null;
  readonly why: string | null;
  readonly decidedAt: number;
  readonly text: string;
  readonly author: string | null;
  readonly totals: VersionTotals | null;
  readonly groups: readonly GroupStanding[] | null;
  readonly change: Change;
}

/** A final Proposal on a section that didn't pass: its title, its outcome and when it was decided. */
export interface NotPassed {
  readonly proposalId: string;
  readonly title: string;
  readonly outcome: 'fail' | 'lapse';
  readonly decidedAt: number;
}

/**
 * How a section got its wording: `passed`, newest first, ending where it
 * began (its founding text, or the Proposal that created it), and
 * `notPassed`, the Proposals on it that failed or lapsed, newest first.
 */
export interface SectionHistory {
  readonly passed: readonly PassedChange[];
  readonly notPassed: readonly NotPassed[];
}

/**
 * One row of a Document's change log: a pass, or the Document's founding
 * (`proposalId` and `title` null), when it took effect, what it did, and the
 * section whose history the row opens, or null for the Document's own
 * founding or creation, which made all its first sections at once.
 */
export interface LogRow {
  readonly proposalId: string | null;
  readonly title: string | null;
  readonly decidedAt: number;
  readonly change: Change;
  readonly section: string | null;
}

/** The tallies a dissolved group's archive kept once it cleared its ballots, by Proposal id (#108). */
export type KeptTallies = Readonly<Record<string, TallyDetail>>;

/** What one pass did to one section: its text before (null before it existed) and after (null once removed). */
interface SectionChange {
  readonly id: string;
  readonly before: string | null;
  readonly after: string | null;
}

/**
 * A final pass, with its winning version, as the replay applies it: what it
 * did, the Document it did it in (`documentOf`), and to which sections.
 */
interface Step {
  readonly proposal: Proposal;
  readonly winner: Version;
  readonly change: PassChange;
  readonly documentId: string | null;
  readonly sections: readonly SectionChange[];
}

/** A Proposal that changes no Document: a steward, rules, dissolve, reconcile, priority or admit one, or a coalition motion in a group. */
const NO_CHANGE = (): null => null;

/**
 * What a pass of each target kind did, given whether its winning text is
 * `""` and its section's text before. Keyed by every kind in the target
 * union, so a kind added later fails `tsc` here until it has an entry of its
 * own: the exhaustive check, without a `switch` whose ten cases would pass
 * the complexity limit.
 */
const DESCRIBED: {
  readonly [K in ProposalTarget['kind']]: (
    removes: boolean,
    before: string | null,
  ) => PassChange | null;
} = {
  edit: (removes, before) => ({ kind: removes ? 'removed' : 'changed', quote: before ?? '' }),
  add: () => ({ kind: 'added' }),
  'new-document': () => ({ kind: 'created' }),
  steward: NO_CHANGE,
  rules: NO_CHANGE,
  dissolve: NO_CHANGE,
  reconcile: NO_CHANGE,
  motion: NO_CHANGE,
  priority: NO_CHANGE,
  admit: NO_CHANGE,
};

/**
 * What a final pass did to its Document (#104), from its target: an edit
 * `changed` its section, or `removed` it when its winning text is `""`; an add
 * `added` one (#75); and a new Document `created` its Document (#92).
 * `before` is the section's text before the pass, which a change or a
 * removal quotes, or null when there was none. Null for a Proposal that
 * changes no Document.
 */
export function describeChange(proposal: Proposal, before: string | null): PassChange | null {
  const { target, outcome } = proposal;
  const winner = outcome.kind === 'pass' ? outcome.version : null;
  const removes = proposal.versions.some((v) => v.id === winner && v.text === '');
  return DESCRIBED[target.kind](removes, before);
}

/** The sections a pass `change`d, given each section's text before it and its winning `text`. */
function sectionsOf(
  change: PassChange,
  proposal: Proposal,
  text: string,
  held: ReadonlyMap<string, string>,
): SectionChange[] {
  const before = held.get(proposal.atom) ?? null;
  switch (change.kind) {
    case 'changed':
      return [{ id: proposal.atom, before, after: text }];
    case 'removed':
      return [{ id: proposal.atom, before, after: null }];
    case 'added':
      return [{ id: proposal.id, before: null, after: text }];
    case 'created':
      return documentSections(text).map((after, i) => ({
        id: `${proposal.id}.${String(i)}`,
        before: null,
        after,
      }));
  }
}

/** The final passes, each with its winning version, in the order the fold applies them. */
function passesInOrder(state: GroupState): { proposal: Proposal; winner: Version }[] {
  const passes = state.proposals.flatMap((proposal) => {
    const { outcome } = proposal;
    if (!proposal.final || outcome.kind !== 'pass') return [];
    const won = proposal.versions.filter((v) => v.id === outcome.version);
    return won.map((winner) => ({ proposal, winner }));
  });
  // `proposals` is in relay order and sort is stable, so equal close times keep relay order.
  return passes.sort((a, b) => closeTime(a.proposal) - closeTime(b.proposal));
}

/**
 * Every final pass that changed a Document, in the order the fold applies
 * them, replayed from the founding text: what each did, in which Document,
 * and to which sections, with their text before and after.
 */
function steps(state: GroupState): Step[] {
  const held = new Map((state.founding?.atoms ?? []).map((atom) => [atom.id, atom.text]));
  return passesInOrder(state).flatMap(({ proposal, winner }) => {
    const change = describeChange(proposal, held.get(proposal.atom) ?? null);
    if (change === null) return [];
    const sections = sectionsOf(change, proposal, winner.text, held);
    for (const { id, after } of sections) {
      if (after === null) held.delete(id);
      else held.set(id, after);
    }
    return [{ proposal, winner, change, documentId: documentOf(state, proposal), sections }];
  });
}

/**
 * When a decision took effect, as the coalition home dates it too: a
 * Proposal's close, its early close or its deadline. A coalition motion
 * closes at the result that fails it (#100); otherwise it's decided once
 * results stop counting, its deadline plus 10,080 minutes, when a pass
 * becomes final and a motion short of results fails.
 */
function decidedAt(state: GroupState, proposal: Proposal): number {
  const settles = state.coalition !== null && proposal.closedAt === null;
  return settles ? proposal.deadline + RESULT_GRACE_MINUTES : closeTime(proposal);
}

/** The winning version's totals: from a cleared archive's kept tally (#108), else the Proposal's own. */
function totalsOf(proposal: Proposal, winner: string, kept: KeptTallies): VersionTotals | null {
  const detail = kept[proposal.id] ?? proposalTally(proposal);
  const won = detail.versions.find((version) => version.id === winner);
  if (won === undefined) return null;
  const { scorers, sum, zeros, quorum } = won;
  return { scorers, sum, zeros, quorum };
}

/** A step's entry in its sections' histories: a coalition motion's carries each group's result, any other its totals. */
function passedEntry(state: GroupState, step: Step, after: string, kept: KeptTallies) {
  const { proposal, winner, change } = step;
  const motion = coalitionProgress(state, proposal.id);
  return {
    proposalId: proposal.id,
    title: proposal.title,
    why: proposal.why,
    decidedAt: decidedAt(state, proposal),
    text: after,
    author: winner.author,
    totals: motion === null ? totalsOf(proposal, winner.id, kept) : null,
    groups: motion === null ? null : motion.groups,
    change,
  };
}

/** The founding text of section `atomId`, as its history's first entry, or none for a section genesis didn't found. */
function foundingEntry(state: GroupState, atomId: string): PassedChange[] {
  const { founding } = state;
  const atom = founding?.atoms.find((candidate) => candidate.id === atomId);
  if (founding === null || atom === undefined) return [];
  const { received, author } = founding;
  const entry = { proposalId: null, title: null, why: null, decidedAt: received, text: atom.text };
  return [{ ...entry, author, totals: null, groups: null, change: { kind: 'founded' } }];
}

/**
 * Section `atomId`'s history (#104): `passed`, newest first, holds its
 * founding text, then every final pass that changed it, each with the text
 * it left, and `notPassed`, newest first, the final Proposals on it that
 * failed or lapsed. A removed section's history ends with its removal. Both
 * are empty for a section the group never had. `kept` holds a cleared
 * archive's tallies (#108), which give its totals in place of its ballots.
 */
export function sectionHistory(
  state: GroupState,
  atomId: string,
  kept: KeptTallies = {},
): SectionHistory {
  const changes = steps(state).flatMap((step) =>
    step.sections
      .filter((section) => section.id === atomId)
      .map((section) => passedEntry(state, step, section.after ?? '', kept)),
  );
  const notPassed = state.proposals.flatMap((proposal): NotPassed[] => {
    const { kind } = proposal.outcome;
    if (!proposal.final || kind === 'pass' || proposal.atom !== atomId) return [];
    const { id, title } = proposal;
    return [{ proposalId: id, title, outcome: kind, decidedAt: decidedAt(state, proposal) }];
  });
  return {
    passed: [...foundingEntry(state, atomId), ...changes].reverse(),
    // Reversed first, so that among equal dates the stable sort keeps the later in relay order first.
    notPassed: notPassed.reverse().sort((a, b) => b.decidedAt - a.decidedAt),
  };
}

/**
 * Document `documentId`'s change log (#104): every final pass that changed
 * it, newest first, by decision date and then relay order, the reverse of
 * the order the fold applies them, ending with its own beginning, the
 * founding text or the Proposal that created it. Each row names the section
 * whose history it opens, a removed one's included. Empty for a Document the
 * group doesn't have.
 */
export function changeLog(state: GroupState, documentId: string): LogRow[] {
  const rows = steps(state)
    .filter((step) => step.documentId === documentId)
    .map(({ proposal, change, sections }) => ({
      proposalId: proposal.id,
      title: proposal.title,
      decidedAt: decidedAt(state, proposal),
      change,
      section: change.kind === 'created' ? null : (sections[0]?.id ?? null),
    }));
  return [...foundingRow(state, documentId), ...rows].reverse();
}

/** A founded Document's first change log row, its founding text, or none for a Document genesis didn't found. */
function foundingRow(state: GroupState, documentId: string): LogRow[] {
  const { founding } = state;
  if (founding === null || !founding.atoms.some((atom) => atom.documentId === documentId)) {
    return [];
  }
  const change = { kind: 'founded' } as const;
  return [{ proposalId: null, title: null, decidedAt: founding.received, change, section: null }];
}
