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

/** Names as plain text, as {@link NameList} sets them: "A", "A and B" or "A, B and C". */
function listText(names: readonly string[]): string {
  const last = names.at(-1) ?? '';
  const rest = names.slice(0, -1).join(`${coalitions.listSeparator} `);
  return rest === '' ? last : `${rest} ${coalitions.and} ${last}`;
}

/** The lines a `progress` line keeps room for: one, or two whose wider wins (#417). */
type Rooms = readonly [room: string, alt?: string];

/**
 * The longest lines an open motion can show, both kept, since which renders
 * wider rests on the glyphs, not the count of characters (#417): every group
 * still waiting, or at 5 groups and more the two-thirds line at its widest,
 * and its own group's fail.
 */
function openRooms(progress: Progress): Rooms {
  const { needed, seats } = progress;
  const names = listText(progress.groups.map((group) => group.name));
  const waiting = needsEvery(progress)
    ? `${coalitions.passedOf(0, seats)} ${coalitions.waitingFor} ${names}${coalitions.end}`
    : coalitions.twoThirds(needed, seats, seats, seats);
  return [waiting, `${coalitions.mine.fail} ${coalitions.waitingMore(needed)}`];
}

/**
 * The longest lines `progress` can show from now on, as plain text: the room
 * its line keeps on a vote's page (#407). Once the coalition has decided,
 * that's a fail's sentence, or a pass's with the day it takes effect, which
 * is longer than what it says once final.
 */
function roomsOf(progress: Progress): Rooms {
  if (progress.outcome === undefined) return openRooms(progress);
  if (progress.outcome === 'fail') {
    return [needsEvery(progress) ? coalitions.failedEvery : coalitions.failedTwoThirds];
  }
  return [`${coalitions.takesEffect} ${formatDay(progress.settles)}${coalitions.end}`];
}

/**
 * The progress line, as the coalition home and a coalition vote's page show
 * it: inside a card's link, a span; on its own, a paragraph that keeps the
 * room its longest lines take (`.steady`, #407, #417), so a group's pass or
 * fail syncing in moves nothing below it, the ballot least of all.
 */
export function ProgressLine({
  progress,
  inline = false,
}: {
  readonly progress: Progress;
  readonly inline?: boolean;
}) {
  if (inline) return <span className="coalition-progress-line">{lineOf(progress)}</span>;
  const [room, alt] = roomsOf(progress);
  return (
    <p className="coalition-progress-line steady" data-room={room} data-room-alt={alt}>
      <span>{lineOf(progress)}</span>
    </p>
  );
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
