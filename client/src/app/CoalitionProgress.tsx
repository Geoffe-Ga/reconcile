/**
 * A coalition motion's progress in words (#120; ADR-0036, ADR-0069).
 *
 * Everything here reads `coalitionProgress`, which reads only the
 * coalition's log: how many groups have passed or failed, never how many
 * people voted or who. Up to 4 groups, or for a motion that needs every
 * group: "2 of 3 groups have passed. Waiting for Oak St Co-op." From 5:
 * "Needs 4 of 5 · 3 passed, 1 didn't". Once the viewer's own group has
 * reported: "Your group passed this. Waiting for 1 more group." Once the
 * coalition has decided, its outcome sentence. Each group's name is in its
 * own `<bdi>`.
 */
import { Fragment, type ReactNode, useId } from 'react';

import type { CoalitionProgress as Progress } from '../engine/coalitionProgress';
import { formatDay } from './format';
import { messages } from './messages';
import { minuteIso } from './time';

const { coalitions } = messages;

/** Names as a list, "A", "A and B" or "A, B and C", each in its own `<bdi>`. */
export function NameList({ names }: { readonly names: readonly string[] }) {
  const last = names.length - 1;
  return names.map((name, index) => (
    <Fragment key={index}>
      {index === 0 ? null : index === last ? ` ${coalitions.and} ` : `${coalitions.listSeparator} `}
      <bdi>{name}</bdi>
    </Fragment>
  ));
}

/** True when every group in the motion's snapshot must pass it. */
function needsEvery(progress: Pick<Progress, 'needed' | 'seats'>): boolean {
  return progress.needed === progress.seats;
}

/**
 * The coalition's outcome sentence: a fail's, at 5 or more groups the
 * two-thirds one, or a pass's, with the day it takes effect while results
 * can still change it (#250).
 */
export function OutcomeSentence({ progress }: { readonly progress: Progress }) {
  if (progress.outcome === 'fail') {
    return <>{needsEvery(progress) ? coalitions.failedEvery : coalitions.failedTwoThirds}</>;
  }
  if (progress.final) return <>{coalitions.passed}</>;
  return (
    <>
      {coalitions.takesEffect}{' '}
      <time dateTime={minuteIso(progress.settles)}>{formatDay(progress.settles)}</time>
      {coalitions.end}
    </>
  );
}

/** What the progress line says, from the most settled thing the coalition knows. */
function lineOf(progress: Progress): ReactNode {
  const { passed, failed, needed, seats, mine } = progress;
  if (progress.outcome !== undefined) return <OutcomeSentence progress={progress} />;
  if (mine !== undefined) {
    return `${coalitions.mine[mine]} ${coalitions.waitingMore(needed - passed)}`;
  }
  if (!needsEvery(progress)) return coalitions.twoThirds(needed, seats, passed, failed);
  return (
    <>
      {coalitions.passedOf(passed, seats)} {coalitions.waitingFor}{' '}
      <NameList names={progress.deciding} />
      {coalitions.end}
    </>
  );
}

/**
 * The progress line, as the coalition home and a coalition vote's page show
 * it: a paragraph, or inside a card's link, a span.
 */
export function ProgressLine({
  progress,
  inline = false,
}: {
  readonly progress: Progress;
  readonly inline?: boolean;
}) {
  const Line = inline ? 'span' : 'p';
  return <Line className="coalition-progress-line">{lineOf(progress)}</Line>;
}

/** One coalition's line on a nested motion (#122): "In Eastside Housing", then its progress. */
function StepLine({ name, progress }: { readonly name: string; readonly progress: Progress }) {
  return (
    <div className="coalition-progress-step">
      <p className="caption">
        {coalitions.progressIn} <bdi>{name}</bdi>
      </p>
      <ProgressLine progress={progress} />
    </div>
  );
}

/** Props for {@link CoalitionProgress}. */
export interface CoalitionProgressProps {
  readonly progress: Progress;
  /** For a motion from further up (#122): each coalition it came through, nearest first. */
  readonly steps?: readonly { readonly name: string; readonly progress: Progress }[];
  /** The name of the coalition whose motion it is, over its own line when there are steps. */
  readonly top?: string;
}

/**
 * `<CoalitionProgress>`: a coalition motion's progress on its Proposal
 * view, under "Across the coalition", with what crosses group lines. A motion
 * from further up (#122) shows each coalition on its way, nearest first, then
 * the one whose motion it is, each line reading only its own seats' results.
 */
export function CoalitionProgress({ progress, steps = [], top = '' }: CoalitionProgressProps) {
  const heading = useId();
  return (
    <section className="card coalition-progress" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {coalitions.progressTitle}
      </h2>
      {steps.length === 0 ? (
        <ProgressLine progress={progress} />
      ) : (
        <>
          {steps.map((step, index) => (
            <StepLine key={index} name={step.name} progress={step.progress} />
          ))}
          <StepLine name={top} progress={progress} />
        </>
      )}
      <p className="caption">
        {steps.length === 0 ? coalitions.motionLine : coalitions.nestedLine}
      </p>
    </section>
  );
}
