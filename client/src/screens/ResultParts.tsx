/**
 * The pieces a closed Proposal's result shares with a priority vote's (#107;
 * DESIGN.md, Result): thanks by name, Propose again, a late ballot's notice,
 * a record that doesn't match this device's ballots (#111), each choice's
 * totals, the individual ballots under a disclosure with the day they
 * expire, or once this device has cleared them, when it did (#111, or a
 * dissolved group's archive, #108), and when voting ran, in relay time.
 */
import { Fragment, type ReactNode, useId } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';

import { formatAverage, formatDay } from '../app/format';
import type { ChatDetails, ChatMoment } from '../app/chatMessages';
import { messages } from '../app/messages';
import type { ShareOutcome } from '../app/share';
import { MotionTitle } from '../app/stewards';
import { formatDate, formatMinute, MINUTE_MS, minuteIso } from '../app/time';
import type { VersionView } from '../app/versionViews';
import { can } from '../engine/capabilities';
import { composeOption } from '../engine/composeOption';
import { ballotsExpireAt } from '../engine/expiry';
import type { Ballot, GroupState, Proposal } from '../engine/fold';
import { displayName } from '../engine/names';
import type { OwnBallot } from '../engine/ownBallot';
import { isPriority, openPriority } from '../engine/priority';
import type { TallyDetail } from '../engine/tally';

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

/** "Thank you, Ben and Ana.", each name inside `<bdi>`. */
export function Thanks({ names }: { readonly names: readonly string[] }) {
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

/** Whether Propose again waits, and the line that says why. */
interface Again {
  readonly busy: boolean;
  readonly why: string;
}

/**
 * Whether `props`' Proposal can be proposed again here, and if so whether it
 * waits: a change, a removal or an add (#75) while another Proposal is open
 * on its section, and a priority vote (#107) while another priority vote is
 * open. A steward or rules vote isn't proposed again from here: Group home
 * says when an election is due (#102), and the Rules page offers each opt-in
 * (#117). Nothing is, while this member leaves or for someone who can't
 * propose.
 */
function againOf(props: ResultViewProps): Again | null {
  const { state, me, proposal, leaving = false } = props;
  const priority = isPriority(proposal);
  const { kind } = proposal.target;
  const again = priority || kind === 'edit' || kind === 'add';
  if (leaving || !again || !can(state, me, 'propose')) return null;
  const { result } = messages;
  return priority
    ? { busy: openPriority(state) !== undefined, why: result.priorityBusy }
    : { busy: composeOption(state, proposal.atom) !== 'propose', why: result.busy };
}

/**
 * Propose again, for someone who can propose and isn't leaving (ADR-0069, as
 * ADR-0073 cuts it: a fresh Proposal with a fresh window). It waits, and says
 * why, while another Proposal is open on the section, or for a priority vote
 * (#107), while another priority vote is open.
 */
export function ProposeAgain({ props }: { readonly props: ResultViewProps }) {
  const reason = useId();
  const again = againOf(props);
  if (again === null) return null;
  const { busy, why } = again;
  return (
    <div className="row result-again">
      <Button
        className="button button-primary"
        isDisabled={busy}
        {...(busy ? { 'aria-describedby': reason } : {})}
        onPress={props.onProposeAgain}
      >
        {messages.result.proposeAgain}
      </Button>
      {busy ? (
        <p id={reason} className="caption">
          {why}
        </p>
      ) : null}
    </div>
  );
}

/** Each record of the decision that doesn't match this device's ballots, by who posted it (#111). */
export function Mismatches({ state, proposal }: Pick<ResultViewProps, 'state' | 'proposal'>) {
  const { mismatchBefore, mismatchAfter } = messages.result;
  return proposal.mismatched.map((author) => (
    <p key={author} className="ballot-notice">
      {mismatchBefore} <bdi>{displayName(state, author)}</bdi> {mismatchAfter}
    </p>
  ));
}

/** "Your vote arrived after voting closed and wasn't counted.", to its author alone. */
export function LateNotice({ own }: { readonly own: OwnBallot }) {
  return own === 'late' ? <p className="ballot-notice">{messages.result.late}</p> : null;
}

/** How the result names each choice: "Version 1 · Ana", or a priority option by its text (#107). */
export type Naming = 'versions' | 'options';

/**
 * "Version 1 · Ana", the version's heading wherever the result names it, what a
 * steward, rules or dissolve ballot decided (#102, #117, #108), or a priority
 * option's text (#107).
 */
function VersionName({ version, naming }: { readonly version: VersionView; naming: Naming }) {
  if (naming === 'options') return <bdi>{version.text}</bdi>;
  if (version.steward !== undefined) return <MotionTitle motion={version.steward.motion} />;
  if (version.rules !== undefined) return <>{version.rules.title}</>;
  if (version.dissolve !== undefined) return <>{version.dissolve.title}</>;
  return (
    <>
      {messages.ballot.version(version.number)} {messages.ballot.separator}{' '}
      <bdi>{version.author}</bdi>
    </>
  );
}

/** Props for {@link Totals}. */
export interface TotalsProps {
  readonly detail: TallyDetail;
  readonly versions: readonly VersionView[];
  readonly naming: Naming;
  /** Its heading's level: 3 in the result, 4 inside the disclosure that holds a priority vote's. */
  readonly level?: 3 | 4;
}

/** Each version's totals, in ballot order: who scored it, its average, its zeros. */
export function Totals({ detail, versions, naming, level = 3 }: TotalsProps) {
  const heading = useId();
  const Title = level === 3 ? 'h3' : 'h4';
  return (
    <div className="result-totals">
      <Title id={heading} className="eyebrow">
        {messages.result.totals}
      </Title>
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
                <VersionName version={version} naming={naming} />
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

/** One score on a priority ballot: "Fix the website: 4 · Strongly supportive", the option in `<bdi>`. */
function OptionScore({ ballot, option }: { readonly ballot: Ballot; option: VersionView }) {
  const { result } = messages;
  const score = ballot.scores[option.id];
  return (
    <>
      <bdi>{option.text}</bdi>
      {result.optionSeparator}{' '}
      {score === undefined ? result.notScored : result.scored(score, messages.ballot.scores[score])}
    </>
  );
}

interface BallotRowProps {
  readonly state: GroupState;
  readonly ballot: Ballot;
  readonly versions: readonly VersionView[];
  readonly naming: Naming;
}

/** One ballot: its voter's name, each score, and the note, if any. */
function BallotRow({ state, ballot, versions, naming }: BallotRowProps) {
  const name = useId();
  const several = versions.length > 1;
  return (
    <li className="result-ballot" aria-labelledby={name}>
      <bdi id={name} className="result-voter">
        {displayName(state, ballot.voter)}
      </bdi>
      <ul className="result-scores">
        {versions.map((version) => (
          <li key={version.id}>
            {naming === 'options' ? (
              <OptionScore ballot={ballot} option={version} />
            ) : (
              scoreText(ballot, version, several)
            )}
          </li>
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

/** Props for {@link Ballots}. */
export interface BallotsProps {
  readonly props: ResultViewProps;
  readonly versions: readonly VersionView[];
  readonly naming: Naming;
  /** The disclosure's label: "Individual ballots (N)" unless given. */
  readonly label?: string;
  /** What the disclosure holds above the ballots, such as a priority vote's totals. */
  readonly children?: ReactNode;
}

/** "Individual scores and notes were cleared on <date>.", where the ballots were (#108). */
export function Cleared({ at }: { readonly at: number }) {
  return (
    <p className="caption">{messages.archive.cleared(formatDate(Math.floor(at / MINUTE_MS)))}</p>
  );
}

/** A relay minute as a day, in a `<time>` element that never breaks across lines. */
function Day({ minute }: { readonly minute: number }) {
  return <time dateTime={minuteIso(minute)}>{formatDay(minute)}</time>;
}

/** "Individual scores and notes were cleared on <date>.", once this device has deleted them (#111). */
function ClearedOn({ props }: { readonly props: ResultViewProps }) {
  const { result } = messages;
  return (
    <p className="caption result-expiry">
      {result.clearedOn} <Day minute={ballotsExpireAt(props.state.rules, props.proposal)} />
      {result.clearedOnEnd}
    </p>
  );
}

/** "Individual scores and notes are visible until <date>. …", while there are ballots to see (#111). */
function VisibleUntil({ props }: { readonly props: ResultViewProps }) {
  const { result } = messages;
  const { state, proposal } = props;
  if (proposal.cleared || proposal.ballots.length === 0) return null;
  return (
    <p className="caption result-expiry">
      {result.visibleUntil} <Day minute={ballotsExpireAt(state.rules, proposal)} />
      {result.visibleUntilEnd}
    </p>
  );
}

/** The ballots, each by its voter's name, or a line that nobody voted. */
function BallotList({
  props,
  versions,
  naming,
  label,
}: Omit<BallotsProps, 'children'> & { label: string }) {
  const { state, proposal } = props;
  if (proposal.ballots.length === 0) return <p className="caption">{messages.result.noBallots}</p>;
  return (
    <ul className="result-list" aria-label={label}>
      {proposal.ballots.map((ballot) => (
        <BallotRow
          key={ballot.voter}
          state={state}
          ballot={ballot}
          versions={versions}
          naming={naming}
        />
      ))}
    </ul>
  );
}

/**
 * Where the ballots were, once they're gone: when a dissolved group's archive
 * cleared them (#108), or when this device did (#111); else the ballots.
 */
function BallotsOrCleared(props: Omit<BallotsProps, 'children'> & { label: string }) {
  const { cleared, proposal } = props.props;
  if (cleared !== undefined) return <Cleared at={cleared.at} />;
  return proposal.cleared ? <ClearedOn props={props.props} /> : <BallotList {...props} />;
}

/**
 * The individual ballots and notes, by name, one tap away (ADR-0010: open
 * inside the group), with the day they expire (#111). Once this device has
 * cleared them (#111), or a dissolved group's archive has (#108), it says
 * when instead. With nothing else to hold, a cleared Proposal's needs no
 * disclosure: only that day is left to say.
 */
export function Ballots({ props, versions, naming, children, ...rest }: BallotsProps) {
  const { proposal } = props;
  if (proposal.cleared && children === undefined) return <ClearedOn props={props} />;
  const label = rest.label ?? messages.result.ballots(proposal.ballots.length);
  return (
    <Disclosure className="reads-as result-ballots">
      <Heading level={3} className="reads-as-heading">
        <Button slot="trigger" className="reads-as-toggle">
          {label}
        </Button>
      </Heading>
      <VisibleUntil props={props} />
      <DisclosurePanel className="result-details">
        {children}
        <BallotsOrCleared props={props} versions={versions} naming={naming} label={label} />
      </DisclosurePanel>
    </Disclosure>
  );
}

/** A relay minute as a date and time, in a `<time>` element that never breaks across lines. */
function At({ minute }: { readonly minute: number }) {
  return <time dateTime={minuteIso(minute)}>{formatMinute(minute)}</time>;
}

/** "Voting ran <start> – <end>." in relay time, adding that everyone had voted after an early close. */
export function Ran({ proposal }: { readonly proposal: Proposal }) {
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
