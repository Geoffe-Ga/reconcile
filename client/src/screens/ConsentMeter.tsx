/**
 * The consent meter (DESIGN.md, Consent meter; ADR-0002; spec §5 and §8):
 * one per version while its vote is open, so the outcome is never a surprise.
 *
 * Two plain bars: the average against the bar's average line, and the share
 * of zeros against its zero line. Each is a React Aria `Meter` named for its
 * line and read in words ("1.9 · Short by 0.1", "8% · Passes"), so its state
 * never rests on color or width. A quorum line follows. Every number, line
 * and pass flag comes from the engine's tally; this holds no threshold.
 */
import { Label, Meter } from 'react-aria-components';

import {
  averageShare,
  formatAverage,
  formatAverageLine,
  formatShortfall,
  formatZeroLine,
  formatZeroShare,
  lineShare,
  zeroShare,
} from '../app/format';
import { messages } from '../app/messages';
import type { Bar } from '../engine/rules';
import type { VersionTally } from '../engine/tally';

/** Props for {@link ConsentMeter}. */
export interface ConsentMeterProps {
  /** The version's place on the ballot, from 1. */
  readonly number: number;
  /** The version's numbers and pass flags, from the engine's tally of the ballots so far. */
  readonly tally: VersionTally;
  /** The bar the engine tallied against. */
  readonly bar: Bar;
  /**
   * How many the ballot counts: its eligible set, fixed when the vote opened
   * (ADR-0015), which no count of scorers passes. The zeros reading keeps its
   * room for it (#417).
   */
  readonly eligible: number;
  /** The meter's name for a priority option (#107), in place of "How version N stands so far". */
  readonly label?: string;
}

interface MeterBarProps {
  /** What the bar measures, such as "Average". */
  readonly name: string;
  /** Its line in words, from the bar, such as "needs 2.5". */
  readonly line: string;
  /** Where the line sits, from 0 to 1 of the bar's width. */
  readonly lineAt: number;
  /** How full the bar is, from 0 to 1. */
  readonly fill: number;
  /** Whether the bar meets its line, which colors the fill as well as the words. */
  readonly met: boolean;
  /** Its value and standing in words, which screen readers hear as its value. */
  readonly reading: string;
  /** Whether the reading shows beside the name too; before any score, the quorum line says it. */
  readonly showReading: boolean;
  /** The widest reading the bar can show, whose room the reading keeps (#407). */
  readonly room: string;
}

/** As a CSS percentage. */
const percent = (share: number): string => `${String(share * 100)}%`;

/**
 * One bar: its name and line, its reading, then the track with its fill and
 * line. The reading keeps the room its widest takes (`.steady`), even before
 * any score, so a ballot syncing in never wraps the head anew and moves the
 * note and Send below it (#407).
 */
function MeterBar({ name, line, lineAt, fill, met, reading, showReading, room }: MeterBarProps) {
  return (
    <Meter className="meter-bar" value={fill * 100} valueLabel={reading}>
      <div className="meter-head">
        <Label className="meter-name">
          {name} {messages.ballot.separator} <span className="meter-line-name">{line}</span>
        </Label>
        <span className="meter-reading steady" data-room={room}>
          <span>{showReading ? reading : null}</span>
        </span>
      </div>
      <div className="meter-track">
        <div
          className={met ? 'meter-fill meter-fill-met' : 'meter-fill'}
          style={{ width: percent(fill) }}
        />
        <div className="meter-line" style={{ left: percent(lineAt) }} />
      </div>
    </Meter>
  );
}

/** The average's reading: "2.4 · Passes" or "1.9 · Short by 0.1". */
function averageReading(tally: VersionTally, bar: Bar): string {
  const { meter } = messages;
  const gap = formatShortfall(tally, bar);
  const standing = tally.averageMet || gap === null ? meter.passes : meter.short(gap);
  return meter.reading(formatAverage(tally), standing);
}

/** The zeros' reading: "0% · Passes" or "20% · Too many zeros: 1 of 5". */
function zeroReading(tally: VersionTally): string {
  const { meter } = messages;
  const standing = tally.zerosMet ? meter.passes : meter.tooManyZeros(tally.zeros, tally.scorers);
  return meter.reading(formatZeroShare(tally), standing);
}

/** The widest average reading at `bar`: no average yet, as far short as it can be. */
function averageRoom(bar: Bar): string {
  const { meter } = messages;
  return meter.reading(formatAverage({ sum: 0, scorers: 0 }), meter.short(formatAverageLine(bar)));
}

/**
 * The widest zeros reading on a ballot that counts `eligible`: every one of
 * them scoring 0. The eligible set is fixed when the vote opens, so the room
 * never widens as more score (#417), and the reading's digits are tabular,
 * so no count it shows takes more.
 */
function zeroRoom(eligible: number): string {
  const { meter } = messages;
  return meter.reading(meter.percent(100), meter.tooManyZeros(eligible, eligible));
}

/**
 * The zeros' line in words: "under 10%", or for removal's bar, which forgives
 * one 0 (ADR-0075 §3, #115), "one at most, or under 5%".
 */
function zeroLineOf(bar: Bar): string {
  const { meter } = messages;
  const line = formatZeroLine(bar);
  return bar.zerosAllowed === undefined
    ? meter.zeroLine(line)
    : meter.zeroLineOr(bar.zerosAllowed, line);
}

/** One version's meter: its two bars and how many have scored it of how many it needs. */
export function ConsentMeter({ number, tally, bar, eligible, label }: ConsentMeterProps) {
  const { meter } = messages;
  const scored = tally.scorers > 0;
  const lines = lineShare(bar);
  return (
    <div className="meter" role="group" aria-label={label ?? meter.label(number)}>
      <p className="eyebrow">{meter.title}</p>
      <MeterBar
        name={meter.average}
        line={meter.averageLine(formatAverageLine(bar))}
        lineAt={lines.average}
        fill={averageShare(tally)}
        met={tally.averageMet}
        reading={scored ? averageReading(tally, bar) : meter.noScores}
        showReading={scored}
        room={averageRoom(bar)}
      />
      <MeterBar
        name={meter.zeros}
        line={zeroLineOf(bar)}
        lineAt={lines.zeros}
        fill={zeroShare(tally)}
        met={tally.zerosMet}
        reading={scored ? zeroReading(tally) : meter.noScores}
        showReading={scored}
        room={zeroRoom(eligible)}
      />
      <p className="caption meter-quorum">
        {scored ? meter.scoredBy(tally.scorers, tally.quorum) : meter.noScores}
      </p>
    </div>
  );
}
