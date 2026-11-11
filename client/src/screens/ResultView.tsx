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
import { type Proposal, proposalTally } from '../engine/fold';
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

/** A pass's sentence: it names the winning version when there were several, and a removal says the section is gone (#75). */
function passSentence(versions: number, winner: number, removed: boolean): string {
  const { result } = messages;
  if (removed) return versions > 1 ? result.passedVersionRemoval(winner) : result.passedRemoval;
  return versions > 1 ? result.passedVersion(winner) : result.passed;
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
      <p className="outcome-sentence">{passSentence(versions.length, index + 1, text === '')}</p>
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

/** A lapse: ADR-0069's sentence, a late ballot's notice, then Propose again. */
function Lapsed({ props }: OutcomeProps) {
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">{messages.result.lapsed}</p>
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

/** What a pass of a steward, rules, dissolve or removal ballot says in place of new text, or null. */
function TargetPassed(props: OutcomeProps) {
  const { steward, rules, dissolve, removal } = props.versions[0] ?? {};
  const { proposal, me } = props.props;
  if (removal !== undefined)
    return <RemovalPassed removal={removal} you={removalTarget(proposal) === me} />;
  if (dissolve !== undefined) return <DissolvePassed />;
  if (steward !== undefined) return <StewardPassed steward={steward} />;
  return rules === undefined ? null : <RulesPassed rules={rules} />;
}

/** The outcome block the result leads with. */
function Outcome(props: OutcomeProps) {
  const { outcome } = props.detail;
  if (outcome.kind === 'pass') {
    return proposalTextless(props.props.proposal) ? (
      <TargetPassed {...props} />
    ) : (
      <Passed {...props} winner={outcome.version} />
    );
  }
  return outcome.kind === 'fail' ? <Failed {...props} /> : <Lapsed {...props} />;
}

/** True for a Proposal whose versions carry no text: anything but an edit or an add (#75). */
function proposalTextless(proposal: Proposal): boolean {
  const { kind } = proposal.target;
  return kind !== 'edit' && kind !== 'add';
}

/** A closed edit's result, from the engine's tally of its ballots, or the tally a cleared archive kept. */
function EditResult(props: ResultViewProps) {
  const { state, proposal, own, cleared } = props;
  const heading = useId();
  const detail = cleared?.tally ?? proposalTally(proposal);
  const versions = versionViews(state, proposal);
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

/** A closed Proposal's result, or a priority vote's (#107), from the engine's tally of its ballots. */
export function ResultView(props: ResultViewProps) {
  return isPriority(props.proposal) ? <PriorityResult {...props} /> : <EditResult {...props} />;
}
