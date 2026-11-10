/**
 * The proposer's voting window (#106; ADR-0074, ADR-0073): how many whole
 * days the vote on a new Proposal runs, within the bounds of its target's
 * class.
 */
import { Button, Group, Input, Label, NumberField, Text } from 'react-aria-components';

import { DAY_MINUTES, type ProposalClass, type Rules, validWindow } from '../engine/rules';
import { messages } from './messages';
import { MINUTE_MS, formatDay } from './time';
import { FieldErrorLine } from './ui';

/** Whole days, written without grouping: a decimal point can't be typed. */
const WHOLE_DAYS: Intl.NumberFormatOptions = { maximumFractionDigits: 0, useGrouping: false };

/** Props for {@link WindowField}. */
export interface WindowFieldProps {
  /** The group's founding rules, whose `windows` bound the choice. */
  readonly rules: Rules;
  /** The class of the Proposal's target, from `targetClass`, which picks the bounds. */
  readonly cls: ProposalClass;
  /** The days chosen, NaN while the field is blank. */
  readonly value: number;
  /** Takes the days chosen once the field commits them: on blur, Enter or a step. */
  readonly onChange: (days: number) => void;
  /** The device clock now, in ms, which the closing line counts from. */
  readonly now: number;
}

/**
 * "Voting time (days)": a React Aria NumberField from `windows[cls].min` to
 * `windows[cls].max`, with a step button either side. Under it, a line from
 * the device clock says about when voting closes; the relay's receipt of the
 * Proposal sets the exact deadline. A value outside the bounds, or none,
 * blocks the form's submit with a message tied to the field: the field
 * reports it rather than clamping, so what the proposer typed is never
 * silently changed. Put it on every composer that opens a new Proposal, and
 * not on one that adds a version, which runs in its Proposal's window.
 */
export function WindowField({ rules, cls, value, onChange, now }: WindowFieldProps) {
  const { min, max } = rules.windows[cls];
  const check = (days: number): string | null =>
    validWindow(rules, cls, days) ? null : messages.window.outside(min, max);
  const line = validWindow(rules, cls, value)
    ? messages.window.closes(formatDay(now + value * DAY_MINUTES * MINUTE_MS))
    : messages.window.range(min, max);
  return (
    <NumberField
      className="field"
      name="window"
      value={value}
      onChange={onChange}
      minValue={min}
      maxValue={max}
      commitBehavior="validate"
      formatOptions={WHOLE_DAYS}
      isRequired
      validate={check}
    >
      <Label className="field-label">{messages.window.label}</Label>
      <Group className="number-group">
        <Button slot="decrement" className="button button-secondary number-step">
          <span aria-hidden="true">{messages.window.fewer}</span>
        </Button>
        <Input className="input input-number" />
        <Button slot="increment" className="button button-secondary number-step">
          <span aria-hidden="true">{messages.window.more}</span>
        </Button>
      </Group>
      <Text slot="description" className="field-hint">
        {line}
      </Text>
      <FieldErrorLine />
    </NumberField>
  );
}
