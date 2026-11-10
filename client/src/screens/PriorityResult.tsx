/**
 * A closed priority vote's result (#107; DESIGN.md, Result; ADR-0069).
 *
 * Top to bottom: the outcome sentence; on a pass, the top option, which is the
 * group's focus now, and thanks to whoever asked; then the options that
 * passed, best first, and those that didn't clear the floor, each by its text
 * alone, with no numbers. A fail says the focus stays as it was; a lapse says
 * ADR-0069's sentence and offers Propose again. Each option's totals and the
 * individual ballots sit under one disclosure, then when voting ran. Every
 * ranking and flag comes from the engine's tally (`rank`), so this holds no
 * threshold of its own.
 */
import { useId } from 'react';

import { messages } from '../app/messages';
import { type VersionView, versionViews } from '../app/versionViews';
import { proposalTally } from '../engine/fold';
import { displayName } from '../engine/names';
import type { TallyDetail } from '../engine/tally';
import {
  Ballots,
  LateNotice,
  ProposeAgain,
  Ran,
  type ResultViewProps,
  Thanks,
  Totals,
} from './ResultParts';

interface PriorityProps {
  readonly props: ResultViewProps;
  readonly detail: TallyDetail;
  readonly options: readonly VersionView[];
}

/** The options with these ids, in the order the ids come. */
function pick(options: readonly VersionView[], ids: readonly string[]): VersionView[] {
  return ids.flatMap((id) => options.filter((option) => option.id === id));
}

/** The outcome sentence, then the focus and thanks on a pass, or Propose again on a lapse. */
function Outcome({ props, detail, options }: PriorityProps) {
  const { result } = messages;
  const { outcome } = detail;
  if (outcome.kind === 'lapse') {
    return (
      <div className="result-outcome">
        <p className="outcome-sentence">{result.lapsed}</p>
        <LateNotice own={props.own} />
        <ProposeAgain props={props} />
      </div>
    );
  }
  if (outcome.kind === 'fail') {
    return (
      <div className="result-outcome">
        <p className="outcome-sentence">{result.noOption}</p>
      </div>
    );
  }
  const [focus] = pick(options, [outcome.version]);
  const asker = displayName(props.state, props.proposal.author) ?? '';
  return (
    <div className="result-outcome">
      <p className="outcome-sentence">{result.focusNow}</p>
      <p className="result-focus">
        <bdi>{focus?.text}</bdi>
      </p>
      <Thanks names={[asker]} />
    </div>
  );
}

/** A labelled list of options by their text: ordered for the ranking, plain for the rest. */
function OptionNames({
  title,
  options,
  ordered,
}: {
  title: string;
  options: VersionView[];
  ordered: boolean;
}) {
  const heading = useId();
  if (options.length === 0) return null;
  const items = options.map((option) => (
    <li key={option.id} className="result-option">
      <bdi>{option.text}</bdi>
    </li>
  ));
  return (
    <div className="result-ranking">
      <h3 id={heading} className="eyebrow">
        {title}
      </h3>
      {ordered ? (
        <ol className="result-list" aria-labelledby={heading}>
          {items}
        </ol>
      ) : (
        <ul className="result-list" aria-labelledby={heading}>
          {items}
        </ul>
      )}
    </div>
  );
}

/**
 * The options that passed, best first, then those that didn't clear the floor,
 * in ballot order. A lapse lists neither: nothing reached quorum.
 */
function Ranking({ detail, options }: Omit<PriorityProps, 'props'>) {
  if (detail.outcome.kind === 'lapse') return null;
  const ranked = detail.ranking.map((option) => option.id);
  const rest = options.filter((option) => !ranked.includes(option.id));
  return (
    <>
      <OptionNames title={messages.result.ranked} options={pick(options, ranked)} ordered />
      <OptionNames title={messages.result.notCleared} options={rest} ordered={false} />
    </>
  );
}

/** A closed priority vote's result, from the engine's tally and ranking of its ballots. */
export function PriorityResult(props: ResultViewProps) {
  const { state, proposal, own } = props;
  const heading = useId();
  const detail = proposalTally(proposal);
  const options = versionViews(state, proposal);
  return (
    <section className="result" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {messages.result.title}
      </h2>
      <Outcome props={props} detail={detail} options={options} />
      {detail.outcome.kind === 'lapse' ? null : <LateNotice own={own} />}
      <Ranking detail={detail} options={options} />
      <Ballots
        props={props}
        versions={options}
        naming="options"
        label={messages.result.details(proposal.ballots.length)}
      >
        <Totals detail={detail} versions={options} naming="options" level={4} />
      </Ballots>
      <Ran proposal={proposal} />
    </section>
  );
}
