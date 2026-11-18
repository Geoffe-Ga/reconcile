/**
 * A closed Proposal's result (DESIGN.md, Result; ADR-0069; spec §8, Result).
 *
 * Top to bottom: the outcome sentence; on a pass, the new text full width and
 * thanks to the winning version's author by name, with no numbers and no
 * animation; on a fail, each version's unmet condition in words; on a lapse,
 * ADR-0069's sentence and Propose again. Then Tell your group's result
 * message (#113), each version's totals, the individual ballots and notes
 * under a disclosure, and when voting ran, in relay time. A ballot that
 * reached the relay too late tells its author so. The disclosure says until
 * when the individual scores and notes stay visible, and once this device has
 * cleared them, when it did (#111), while the outcome and totals stay. A
 * record of the decision that doesn't match this device's ballots names who
 * posted it. No result offers a part-ways action (ADR-0068). Everything here
 * is read from the group's own log on this device; nothing is sent to the
 * relay. Once a dissolved group's archive has cleared its ballots (#108), the
 * totals come from the tally this device kept, and the ballots give way to
 * when they were cleared. A priority vote's result is PriorityResult.tsx's
 * (#107); the two share ResultParts.tsx.
 */
import { type ReactNode, useId } from 'react';

import { AtomBadge } from '../app/AtomBadge';
import { OutcomeSentence } from '../app/CoalitionProgress';
import { formatAverage, formatAverageLine, formatShortfall } from '../app/format';
import { messages } from '../app/messages';
import type { RulesView } from '../app/optInLines';
import { Named } from '../app/stewards';
import { TellYourGroup } from '../app/TellYourGroup';
import { AtomText } from '../app/text/AtomText';
import {
  type RemovalView,
  type StewardView,
  type VersionView,
  versionViews,
} from '../app/versionViews';
import type { CoalitionProgress } from '../engine/coalitionProgress';
import { publishedBy, shelfLineOf } from '../engine/dispatches';
import { type GroupState, type Proposal, proposalTally } from '../engine/fold';
import { isPriority } from '../engine/priority';
import { removalTarget } from '../engine/removal';
import type { Bar } from '../engine/rules';
import type { TallyDetail, VersionTally } from '../engine/tally';
import { PriorityResult } from './PriorityResult';
import {
  Ballots,
  Cleared,
  LateNotice,
  Mismatches,
  ProposeAgain,
  Ran,
  type ResultViewProps,
  Thanks,
  Totals,
} from './ResultParts';

export type { ClearedResult, ResultViewProps } from './ResultParts';

/** What the outcome blocks read. */
interface OutcomeProps {
  readonly props: ResultViewProps;
  readonly detail: TallyDetail;
  readonly versions: readonly VersionView[];
}

/** What a pass did: changed a section, removed it (#75), or made a new Document (#92). */
type PassKind = 'changed' | 'removed' | 'created';

/**
 * A pass's sentence: it names the winning version when there were several, a
 * removal says the section is gone (#75), and a new Document that it reads
 * as its winning text (#92).
 */
function passSentence(versions: number, winner: number, kind: PassKind): string {
  const { result } = messages;
  const several = versions > 1;
  if (kind === 'removed')
    return several ? result.passedVersionRemoval(winner) : result.passedRemoval;
  if (kind === 'created') {
    return several ? result.passedVersionDocument(winner) : result.passedDocument;
  }
  return several ? result.passedVersion(winner) : result.passed;
}

/** What a passed Proposal did with its winning `text`. */
function passKind(proposal: Proposal, text: string): PassKind {
  if (proposal.target.kind === 'new-document') return 'created';
  return text === '' ? 'removed' : 'changed';
}

/** A steward Proposal's pass: who is now steward for the seat, or who no longer is (#102). */
function StewardPassed({ steward }: { readonly steward: StewardView }) {
  const { motion } = steward;
  const { stewards } = messages;
  const parts = motion.kind === 'elect' ? stewards.elected(motion.seat) : stewards.recalled;
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">
        <Named parts={parts} name={motion.name} />
      </p>
    </div>
  );
}

/**
 * What a section's pass says first (#103, #116): that it has moved, or the
 * class a class Proposal gave it, by the line its card led with.
 */
function sectionPassed(version: VersionView): string {
  const { result } = messages;
  const to = version.protect?.to;
  if (to === undefined) return result.passedMove;
  if (to === 'eternal') return result.passedEternal;
  return to === 'ordinary' ? result.passedUnprotected : result.passedEntrenched;
}

/**
 * A move's pass (#103) or a class Proposal's (#116): that the section has
 * moved, or what it is now, with its new badge, the section as it reads, and
 * thanks to whoever proposed it.
 */
function SectionPassed({ version }: { readonly version: VersionView }) {
  const text = (version.move ?? version.protect)?.text ?? null;
  const to = version.protect?.to;
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">{sectionPassed(version)}</p>
      {to === 'entrenched' || to === 'eternal' ? <AtomBadge cls={to} /> : null}
      {text === null ? null : <AtomText text={text} className="atom-card result-text" />}
      <Thanks names={[version.author]} />
    </div>
  );
}

/** A rules Proposal's pass: what is now on or off (#117). */
function RulesPassed({ rules }: { readonly rules: RulesView }) {
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">{rules.passed}</p>
    </div>
  );
}

/**
 * A pass: its sentence, the winning text as the Document now reads, or no
 * text when it removed the section, and thanks. No numbers.
 */
function Passed({ props, versions, winner }: OutcomeProps & { readonly winner: string }) {
  const { proposal } = props;
  const index = versions.findIndex((version) => version.id === winner);
  const shown = versions[index];
  const text = shown?.text ?? '';
  // The proposer wrote version 1; a later version's author is thanked first.
  const byProposer = proposal.versions[index]?.author === proposal.author;
  const names = [shown?.author ?? '', ...(byProposer ? [] : [versions[0]?.author ?? ''])];
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">
        {passSentence(versions.length, index + 1, passKind(proposal, text))}
      </p>
      {text === '' ? null : <AtomText text={text} className="atom-card result-text" />}
      <Thanks names={names} />
    </div>
  );
}

/** What a version missed, in words: quorum, the average, the zeros. */
function unmet(version: VersionTally, bar: Bar): string[] {
  const { result } = messages;
  const missed: string[] = [];
  if (!version.atQuorum) missed.push(result.belowQuorum(version.scorers, version.quorum));
  if (version.scorers === 0) return missed;
  const gap = formatShortfall(version, bar);
  if (!version.averageMet && gap !== null) {
    missed.push(result.shortOf(formatAverage(version), formatAverageLine(bar), gap));
  }
  if (!version.zerosMet) missed.push(result.tooManyZeros(version.zeros, version.scorers));
  return missed;
}

/** A fail: its sentence, then each version's unmet conditions, numbered when there are several. */
function Failed({ detail, versions }: OutcomeProps) {
  const several = versions.length > 1;
  const reasons = detail.versions.flatMap((version, index) =>
    unmet(version, detail.bar).map((condition) =>
      several ? messages.result.unmet(index + 1, condition) : condition,
    ),
  );
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">
        {several ? messages.result.failedVersions : messages.result.failed}
      </p>
      {reasons.map((reason) => (
        <p key={reason} className="result-reason">
          {reason}
        </p>
      ))}
    </div>
  );
}

/**
 * A lapse: ADR-0069's sentence, a late ballot's notice, then Propose again.
 * A coalition motion's lapse goes to the coalition as a fail, so it says
 * that instead (#100, #120).
 */
function Lapsed({ props }: OutcomeProps) {
  const motion = props.proposal.target.kind === 'motion';
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">
        {motion ? messages.coalitions.motionLapsed : messages.result.lapsed}
      </p>
      <LateNotice own={props.own} />
      <ProposeAgain props={props} />
    </div>
  );
}

/** A dissolve Proposal's pass (#108): the group has dissolved. */
function DissolvePassed() {
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">{messages.dissolve.passed}</p>
    </div>
  );
}

/**
 * A removal's pass (#115): the person it named is no longer in the group, or,
 * on their own device, they aren't.
 */
function RemovalPassed({ removal, you }: { readonly removal: RemovalView; readonly you: boolean }) {
  const { removal: words } = messages;
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">
        {you ? words.passedYou : <Named parts={words.passed} name={removal.name} />}
      </p>
    </div>
  );
}

/**
 * A Dispatch put to the vote's pass: it went out, and the coalition votes
 * next (#126), unless it was put to the vote only for the public shelf (#430).
 */
function dispatchPassed(target: Proposal['target']): string {
  const { rising } = messages;
  return target.kind === 'dispatch' && target.ceiling === 0 ? rising.passedHere : rising.passed;
}

/**
 * A reconcile Proposal's or a coalition motion's pass (#114): only the
 * group's pass goes to the coalition, which decides with every group's. A
 * Dispatch put to the group's vote went out, and the coalition votes next (#126).
 */
function DecisionPassed({ proposal }: { readonly proposal: OutcomeProps['props']['proposal'] }) {
  const { coalitions } = messages;
  const { kind } = proposal.target;
  const sentence =
    kind === 'dispatch'
      ? dispatchPassed(proposal.target)
      : kind === 'reconcile'
        ? coalitions.reconcilePassed
        : coalitions.motionPassed;
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">{sentence}</p>
    </div>
  );
}

/**
 * A pass's block: what a one-card ballot decided, or the winning text as the
 * Document reads. A coalition motion's pass in the group only goes to the
 * coalition (#120), whose own result says what changed.
 */
function PassOutcome({ props, winner }: { props: OutcomeProps; winner: string }) {
  const first = props.versions[0];
  const { proposal, me } = props.props;
  if (first?.removal !== undefined) {
    return <RemovalPassed removal={first.removal} you={removalTarget(proposal) === me} />;
  }
  if (first?.decision !== undefined || proposal.target.kind === 'motion') {
    return <DecisionPassed proposal={proposal} />;
  }
  const decided = first === undefined ? null : oneCardPassed(first);
  return decided ?? <Passed {...props} winner={winner} />;
}

/**
 * What a one-card ballot's pass says: a section's move (#103) or protection
 * (#116), dissolving (#108), a steward (#102) or an opt-in (#117); null for
 * a ballot of text.
 */
function oneCardPassed(first: VersionView): ReactNode {
  const { steward, rules, dissolve, move, protect } = first;
  if (move !== undefined || protect !== undefined) return <SectionPassed version={first} />;
  if (dissolve !== undefined) return <DissolvePassed />;
  if (steward !== undefined) return <StewardPassed steward={steward} />;
  return rules === undefined ? null : <RulesPassed rules={rules} />;
}

/** The outcome block the result leads with. */
function Outcome(props: OutcomeProps) {
  const { outcome } = props.detail;
  if (outcome.kind === 'pass') return <PassOutcome props={props} winner={outcome.version} />;
  return outcome.kind === 'fail' ? <Failed {...props} /> : <Lapsed {...props} />;
}

/** The Dispatch line alone of a ballot with a shelf line (#430), which decides the outcome. */
function withoutShelf(detail: TallyDetail, versions: readonly VersionView[], shelf: string | null) {
  if (shelf === null) return { detail, versions };
  return {
    detail: { ...detail, versions: detail.versions.filter((line) => line.id !== shelf) },
    versions: versions.filter((version) => version.id !== shelf),
  };
}

interface ShelfOutcomeProps {
  readonly state: GroupState;
  readonly proposal: Proposal;
  readonly detail: TallyDetail;
}

/**
 * What the shelf line decided (#430): the group put its name to the Dispatch
 * on the public shelf; or not, because the Dispatch failed, the door wasn't
 * listed at the close, or the line itself fell short, with what it missed.
 */
function ShelfOutcome({ state, proposal, detail }: ShelfOutcomeProps) {
  const shelf = shelfLineOf(proposal);
  const line = detail.versions.find((version) => version.id === shelf);
  if (line === undefined) return null;
  const { shelfLine } = messages;
  const sentence = publishedBy(state).includes(proposal.id)
    ? shelfLine.published
    : detail.outcome.kind !== 'pass'
      ? shelfLine.dispatchFailed
      : line.passes
        ? shelfLine.unlisted
        : shelfLine.failed;
  const missed = sentence === shelfLine.failed ? unmet(line, detail.bar) : [];
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">{sentence}</p>
      {missed.map((reason) => (
        <p key={reason} className="result-reason">
          {reason}
        </p>
      ))}
    </div>
  );
}

/** A closed edit's result, from the engine's tally of its ballots, or the tally a cleared archive kept. */
function EditResult(props: ResultViewProps) {
  const { state, proposal, own, cleared } = props;
  const heading = useId();
  const detail = cleared?.tally ?? proposalTally(proposal);
  const versions = versionViews(state, proposal, props.names ?? state);
  const decided = withoutShelf(detail, versions, shelfLineOf(proposal));
  return (
    <section className="result" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {messages.result.title}
      </h2>
      <Outcome props={props} detail={decided.detail} versions={decided.versions} />
      <ShelfOutcome state={state} proposal={proposal} detail={detail} />
      {detail.outcome.kind === 'lapse' ? null : <LateNotice own={own} />}
      <Mismatches state={state} proposal={proposal} />
      {props.leaving === true ? null : (
        <TellYourGroup
          moment="result"
          proposal={proposal}
          onTell={props.onTell}
          {...(props.voteLink === undefined ? {} : { voteLink: props.voteLink })}
        />
      )}
      <Totals detail={detail} versions={versions} naming="versions" />
      {cleared === undefined ? (
        <Ballots props={props} versions={versions} naming="versions" />
      ) : (
        <Cleared at={cleared.at} />
      )}
      <Ran proposal={proposal} />
    </section>
  );
}

/** Props for {@link CoalitionResult}. */
export interface CoalitionResultProps {
  /** The motion's progress once the coalition has decided it (`coalitionProgress`). */
  readonly progress: CoalitionProgress;
  /** The text a final pass put in the coalition's Document, or `""` for none, as admitting a group has. */
  readonly text: string;
  /** The proposer's name in the coalition, thanked once its pass is final, or `""` for none. */
  readonly author: string;
}

/** Each member group, in seat order, with whether it passed, didn't, or is still deciding. */
function GroupStandings({ groups }: { readonly groups: CoalitionProgress['groups'] }) {
  const heading = useId();
  const { coalitions } = messages;
  return (
    <div className="result-totals">
      <h3 id={heading} className="eyebrow">
        {coalitions.eachGroup}
      </h3>
      <ul className="result-list" aria-labelledby={heading}>
        {groups.map((group, index) => (
          <li key={index} className="result-row">
            <p className="result-version">
              <bdi>{group.name}</bdi>
            </p>
            <p className="caption">{coalitions.standing[group.result ?? 'deciding']}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The coalition's result on a motion (#120; ADR-0036, ADR-0069), shown on its
 * vote in each member group once the coalition has decided it. A final pass
 * reads "The coalition passed this. It now reads:", the new text full width
 * and thanks to its proposer by their coalition name, with no numbers. A
 * pass not yet final says the day it takes effect (#250); a fail says not
 * every group passed it, or from 5 groups, fewer than two-thirds. Then each
 * group with "Passed" or "Didn't pass": only those cross group lines, so no
 * group's ballots, notes or counts appear here; each group's own stay in its
 * own result below.
 */
export function CoalitionResult({ progress, text, author }: CoalitionResultProps) {
  const heading = useId();
  const passed = progress.outcome === 'pass' && progress.final;
  const reads = passed && text !== '';
  return (
    <section className="result coalition-result" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {messages.coalitions.resultTitle}
      </h2>
      <div className="result-outcome">
        <p className="outcome-sentence">
          {reads ? messages.coalitions.nowReads : <OutcomeSentence progress={progress} />}
        </p>
        {reads ? <AtomText text={text} className="atom-card result-text" /> : null}
        {passed && author !== '' ? <Thanks names={[author]} /> : null}
      </div>
      <GroupStandings groups={progress.groups} />
    </section>
  );
}

/** A closed Proposal's result, or a priority vote's (#107), from the engine's tally of its ballots. */
export function ResultView(props: ResultViewProps) {
  return isPriority(props.proposal) ? <PriorityResult {...props} /> : <EditResult {...props} />;
}
