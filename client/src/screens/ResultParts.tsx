/**
 * The pieces a closed Proposal's result shares with a priority vote's (#107;
 * DESIGN.md, Result): thanks by name, Propose again, a late ballot's notice,
 * each choice's totals, the individual ballots under a disclosure, and when
 * voting ran, in relay time.
 */
import { Fragment, type ReactNode, useId } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';

import { formatAverage } from '../app/format';
import { messages } from '../app/messages';
import { formatMinute, minuteIso } from '../app/time';
import type { VersionView } from '../app/versionViews';
import { can } from '../engine/capabilities';
import { composeOption } from '../engine/composeOption';
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

/**
 * Propose again, for someone who can propose (ADR-0069, as ADR-0073 cuts it:
 * a fresh Proposal with a fresh window). It waits, and says why, while
 * another Proposal is open on the section.
 */
export function ProposeAgain({ props }: { readonly props: ResultViewProps }) {
  const { state, me, proposal, onProposeAgain } = props;
  const reason = useId();
  if (!can(state, me, 'propose')) return null;
  const priority = isPriority(proposal);
  const busy = priority
    ? openPriority(state) !== undefined
    : composeOption(state, proposal.atom) !== 'propose';
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
          {priority ? messages.result.priorityBusy : messages.result.busy}
        </p>
      ) : null}
    </div>
  );
}

/** "Your vote arrived after voting closed and wasn't counted.", to its author alone. */
export function LateNotice({ own }: { readonly own: OwnBallot }) {
  return own === 'late' ? <p className="ballot-notice">{messages.result.late}</p> : null;
}

/** How the result names each choice: "Version 1 · Ana", or a priority option by its text (#107). */
export type Naming = 'versions' | 'options';

/** "Version 1 · Ana", the version's heading wherever the result names it, or an option's text. */
function VersionName({ version, naming }: { readonly version: VersionView; naming: Naming }) {
  if (naming === 'options') return <bdi>{version.text}</bdi>;
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

/** The individual ballots and notes, by name, one tap away (ADR-0010: open inside the group). */
export function Ballots({ props, versions, naming, children, ...rest }: BallotsProps) {
  const { state, proposal } = props;
  const label = rest.label ?? messages.result.ballots(proposal.ballots.length);
  return (
    <Disclosure className="reads-as result-ballots">
      <Heading level={3} className="reads-as-heading">
        <Button slot="trigger" className="reads-as-toggle">
          {label}
        </Button>
      </Heading>
      <DisclosurePanel className="result-details">
        {children}
        {proposal.ballots.length === 0 ? (
          <p className="caption">{messages.result.noBallots}</p>
        ) : (
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
