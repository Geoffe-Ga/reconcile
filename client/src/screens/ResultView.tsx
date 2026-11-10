/**
 * A closed Proposal's result (DESIGN.md, Result; ADR-0069; spec §8, Result).
 *
 * Top to bottom: the outcome sentence; on a pass, the new text full width and
 * thanks to the winning version's author by name, with no numbers and no
 * animation; on a fail, each version's unmet condition in words; on a lapse,
 * ADR-0069's sentence and Propose again. Then Tell your group's result
 * message (#113), each version's totals, the individual ballots and notes
 * under a disclosure, and when voting ran, in relay time. A ballot that
 * reached the relay too late tells its author so. No result offers a
 * part-ways action (ADR-0068). Everything here is read from the group's own
 * log on this device; nothing is sent to the relay. Once a dissolved group's
 * archive has cleared its ballots (#108), the totals come from the tally this
 * device kept, and the ballots give way to when they were cleared.
 */
import { Fragment, useId } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';

import type { ChatDetails, ChatMoment } from '../app/chatMessages';
import { formatAverage, formatAverageLine, formatShortfall } from '../app/format';
import { messages } from '../app/messages';
import type { ShareOutcome } from '../app/share';
import { MotionTitle, Named } from '../app/stewards';
import { TellYourGroup } from '../app/TellYourGroup';
import { AtomText } from '../app/text/AtomText';
import { formatDate, formatMinute, MINUTE_MS, minuteIso } from '../app/time';
import type { RulesView } from '../app/optInLines';
import {
  type RemovalView,
  type StewardView,
  type VersionView,
  versionViews,
} from '../app/versionViews';
import { can } from '../engine/capabilities';
import { composeOption } from '../engine/composeOption';
import type { Ballot, GroupState, Proposal } from '../engine/fold';
import { proposalTally } from '../engine/fold';
import { displayName } from '../engine/names';
import type { OwnBallot } from '../engine/ownBallot';
import { removalTarget } from '../engine/removal';
import type { Bar } from '../engine/rules';
import type { TallyDetail, VersionTally } from '../engine/tally';

/** Props for {@link ResultView}. */
export interface ResultViewProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** The Proposal, once the fold says it has closed. */
  readonly proposal: Proposal;
  /** This device's author id in the group. */
  readonly me: string;
  /** Where this viewer's own ballot stands: a late one is named to them alone. */
  readonly own: OwnBallot;
  /** Opens the composer to propose a lapsed Proposal again. */
  readonly onProposeAgain: () => void;
  /** Shares the result message into the group's chat, or copies it (#113). */
  readonly onTell: (moment: ChatMoment, details: ChatDetails) => Promise<ShareOutcome>;
  /**
   * Whether this device's leave waits for the relay (#77), or the group has
   * dissolved (#108): then nothing is proposed again, and the result offers
   * no message to tell the group.
   */
  readonly leaving?: boolean;
  /** Once a dissolved group's ballots are cleared (#108): when, and the tally kept for this Proposal. */
  readonly cleared?: ClearedResult;
}

/** A Proposal's result in a cleared archive: when this device cleared it, and its kept tally (#108). */
export interface ClearedResult {
  /** When the ballots were cleared, in device milliseconds. */
  readonly at: number;
  readonly tally: TallyDetail;
}

/** What the outcome blocks read. */
interface OutcomeProps {
  readonly props: ResultViewProps;
  readonly detail: TallyDetail;
  readonly versions: readonly VersionView[];
}

/** "Thank you, Ben and Ana.", each name inside `<bdi>`. */
function Thanks({ names }: { readonly names: readonly string[] }) {
  const { result } = messages;
  return (
    <p className="result-thanks">
      {result.thanks}{' '}
      {names.map((name, index) => (
        <Fragment key={name}>
          {index > 0 ? ` ${result.and} ` : null}
          <bdi>{name}</bdi>
        </Fragment>
      ))}
      {result.end}
    </p>
  );
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

/** A pass: its sentence, the winning text as the Document now reads, and thanks. No numbers. */
function Passed({ props, versions, winner }: OutcomeProps & { readonly winner: string }) {
  const { proposal } = props;
  const index = versions.findIndex((version) => version.id === winner);
  const shown = versions[index];
  const sentence =
    versions.length > 1 ? messages.result.passedVersion(index + 1) : messages.result.passed;
  // The proposer wrote version 1; a later version's author is thanked first.
  const byProposer = proposal.versions[index]?.author === proposal.author;
  const names = [shown?.author ?? '', ...(byProposer ? [] : [versions[0]?.author ?? ''])];
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">{sentence}</p>
      <AtomText text={shown?.text ?? ''} className="atom-card result-text" />
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
 * Propose again, for someone who can propose and isn't leaving (ADR-0069, as
 * ADR-0073 cuts it: a fresh Proposal with a fresh window). It waits, and says
 * why, while another Proposal is open on the section.
 */
function ProposeAgain({ props }: { readonly props: ResultViewProps }) {
  const { state, me, proposal, onProposeAgain, leaving = false } = props;
  const reason = useId();
  // A steward vote isn't proposed again from here: Group home says when an election is due (#102).
  if (leaving || proposal.target.kind !== 'edit' || !can(state, me, 'propose')) return null;
  const busy = composeOption(state, proposal.atom) !== 'propose';
  return (
    <div className="row result-again">
      <Button
        className="button button-primary"
        isDisabled={busy}
        {...(busy ? { 'aria-describedby': reason } : {})}
        onPress={onProposeAgain}
      >
        {messages.result.proposeAgain}
      </Button>
      {busy ? (
        <p id={reason} className="caption">
          {messages.result.busy}
        </p>
      ) : null}
    </div>
  );
}

/** "Your vote arrived after voting closed and wasn't counted.", to its author alone. */
function LateNotice({ own }: { readonly own: OwnBallot }) {
  return own === 'late' ? <p className="ballot-notice">{messages.result.late}</p> : null;
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

/** True for a Proposal whose one version has no text: anything but an edit. */
function proposalTextless(proposal: Proposal): boolean {
  return proposal.target.kind !== 'edit';
}

/**
 * "Version 1 · Ana", the version's heading wherever the result names it, or
 * what a steward, rules, dissolve or removal ballot decided.
 */
function VersionName({ version }: { readonly version: VersionView }) {
  if (version.steward !== undefined) return <MotionTitle motion={version.steward.motion} />;
  if (version.rules !== undefined) return <>{version.rules.title}</>;
  if (version.dissolve !== undefined) return <>{version.dissolve.title}</>;
  if (version.removal !== undefined) {
    return <Named parts={messages.removal.ballotTitle} name={version.removal.name} />;
  }
  return (
    <>
      {messages.ballot.version(version.number)} {messages.ballot.separator}{' '}
      <bdi>{version.author}</bdi>
    </>
  );
}

/** Each version's totals, in ballot order: who scored it, its average, its zeros. */
function Totals({ detail, versions }: Omit<OutcomeProps, 'props'>) {
  const heading = useId();
  return (
    <div className="result-totals">
      <h3 id={heading} className="eyebrow">
        {messages.result.totals}
      </h3>
      <ul className="result-list" aria-labelledby={heading}>
        {versions.map((version, index) => {
          const totals = detail.versions[index];
          const line =
            totals === undefined || totals.scorers === 0
              ? messages.result.noScores
              : messages.result.totalsLine(totals.scorers, formatAverage(totals), totals.zeros);
          return (
            <li key={version.id} className="result-row">
              <p className="result-version">
                <VersionName version={version} />
              </p>
              <p className="caption">{line}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One score on a ballot: "4 · Strongly supportive", numbered by version when there are several. */
function scoreText(ballot: Ballot, version: VersionView, several: boolean): string {
  const { result } = messages;
  const score = ballot.scores[version.id];
  if (score === undefined) return result.unscored(version.number);
  const scored = result.scored(score, messages.ballot.scores[score]);
  return several ? result.scoreOn(version.number, scored) : scored;
}

interface BallotRowProps {
  readonly state: GroupState;
  readonly ballot: Ballot;
  readonly versions: readonly VersionView[];
}

/** One ballot: its voter's name, each score, and the note, if any. */
function BallotRow({ state, ballot, versions }: BallotRowProps) {
  const name = useId();
  const several = versions.length > 1;
  return (
    <li className="result-ballot" aria-labelledby={name}>
      <bdi id={name} className="result-voter">
        {displayName(state, ballot.voter)}
      </bdi>
      <ul className="result-scores">
        {versions.map((version) => (
          <li key={version.id}>{scoreText(ballot, version, several)}</li>
        ))}
      </ul>
      {ballot.note === null ? null : (
        <p className="result-note" dir="auto">
          {ballot.note}
        </p>
      )}
    </li>
  );
}

/** The individual ballots and notes, by name, one tap away (ADR-0010: open inside the group). */
function Ballots({ props, versions }: Omit<OutcomeProps, 'detail'>) {
  const { state, proposal } = props;
  const label = messages.result.ballots(proposal.ballots.length);
  return (
    <Disclosure className="reads-as result-ballots">
      <Heading level={3} className="reads-as-heading">
        <Button slot="trigger" className="reads-as-toggle">
          {label}
        </Button>
      </Heading>
      <DisclosurePanel>
        {proposal.ballots.length === 0 ? (
          <p className="caption">{messages.result.noBallots}</p>
        ) : (
          <ul className="result-list" aria-label={label}>
            {proposal.ballots.map((ballot) => (
              <BallotRow key={ballot.voter} state={state} ballot={ballot} versions={versions} />
            ))}
          </ul>
        )}
      </DisclosurePanel>
    </Disclosure>
  );
}

/** A relay minute as a date and time, in a `<time>` element that never breaks across lines. */
function At({ minute }: { readonly minute: number }) {
  return <time dateTime={minuteIso(minute)}>{formatMinute(minute)}</time>;
}

/** "Voting ran <start> – <end>." in relay time, adding that everyone had voted after an early close. */
function Ran({ proposal }: { readonly proposal: Proposal }) {
  const { result } = messages;
  const early = proposal.closedAt !== null;
  return (
    <p className="caption result-ran">
      {result.ranFrom} <At minute={proposal.received} /> {result.ranTo}{' '}
      <At minute={proposal.closedAt ?? proposal.deadline} />
      {early ? result.ranEarlyEnd : result.ranEnd}
    </p>
  );
}

/** "Individual scores and notes were cleared on <date>.", where the ballots were. */
function Cleared({ at }: { readonly at: number }) {
  return (
    <p className="caption">{messages.archive.cleared(formatDate(Math.floor(at / MINUTE_MS)))}</p>
  );
}

/** A closed Proposal's result, from the engine's tally of its ballots, or the tally a cleared archive kept. */
export function ResultView(props: ResultViewProps) {
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
      {props.leaving === true ? null : (
        <TellYourGroup moment="result" proposal={proposal} onTell={props.onTell} />
      )}
      <Totals detail={detail} versions={versions} />
      {cleared === undefined ? (
        <Ballots props={props} versions={versions} />
      ) : (
        <Cleared at={cleared.at} />
      )}
      <Ran proposal={proposal} />
    </section>
  );
}
