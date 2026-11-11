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
import { useId } from 'react';

import { OutcomeSentence } from '../app/CoalitionProgress';
import { formatAverage, formatAverageLine, formatShortfall } from '../app/format';
import { messages } from '../app/messages';
import type { RulesView } from '../app/optInLines';
import { Named } from '../app/stewards';
import { TellYourGroup } from '../app/TellYourGroup';
import { AtomText } from '../app/text/AtomText';
import { type StewardView, type VersionView, versionViews } from '../app/versionViews';
import type { CoalitionProgress } from '../engine/coalitionProgress';
import { type Proposal, proposalTally } from '../engine/fold';
import { isPriority } from '../engine/priority';
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
 * A reconcile Proposal's or a coalition motion's pass (#114): only the
 * group's pass goes to the coalition, which decides with every group's.
 */
function DecisionPassed({ proposal }: { readonly proposal: OutcomeProps['props']['proposal'] }) {
  const { coalitions } = messages;
  const sentence =
    proposal.target.kind === 'reconcile' ? coalitions.reconcilePassed : coalitions.motionPassed;
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
  const { steward, rules, dissolve, decision } = props.versions[0] ?? {};
  const { proposal } = props.props;
  if (decision !== undefined || proposal.target.kind === 'motion') {
    return <DecisionPassed proposal={proposal} />;
  }
  if (dissolve !== undefined) return <DissolvePassed />;
  if (steward !== undefined) return <StewardPassed steward={steward} />;
  if (rules !== undefined) return <RulesPassed rules={rules} />;
  return <Passed {...props} winner={winner} />;
}

/** The outcome block the result leads with. */
function Outcome(props: OutcomeProps) {
  const { outcome } = props.detail;
  if (outcome.kind === 'pass') return <PassOutcome props={props} winner={outcome.version} />;
  return outcome.kind === 'fail' ? <Failed {...props} /> : <Lapsed {...props} />;
}

/** A closed edit's result, from the engine's tally of its ballots, or the tally a cleared archive kept. */
function EditResult(props: ResultViewProps) {
  const { state, proposal, own, cleared } = props;
  const heading = useId();
  const detail = cleared?.tally ?? proposalTally(proposal);
  const versions = versionViews(state, proposal, props.names ?? state);
  return (
    <section className="result" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {messages.result.title}
      </h2>
      <Outcome props={props} detail={detail} versions={versions} />
      {detail.outcome.kind === 'lapse' ? null : <LateNotice own={own} />}
      <Mismatches state={state} proposal={proposal} />
      {props.leaving === true ? null : (
        <TellYourGroup moment="result" proposal={proposal} onTell={props.onTell} />
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
