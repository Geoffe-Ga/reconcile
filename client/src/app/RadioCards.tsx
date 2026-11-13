/**
 * A list of radio cards (#378): a React Aria RadioGroup whose options are
 * whole cards, each with its name and, when given, one line tied to it as a
 * description. The level picker, Send a Dispatch's Document picker and its
 * "How far can it go?" picker each show one.
 */
import type { ReactNode } from 'react';
import { Label, RadioButton, RadioField, RadioGroup, Text } from 'react-aria-components';

/** One card: the value it picks, its name, and the line that says what it means. */
export interface RadioCard {
  readonly value: string;
  readonly label: ReactNode;
  readonly description?: ReactNode;
}

/** Props for {@link RadioCards}. */
export interface RadioCardsProps {
  /** The group's label. */
  readonly label: string;
  /** A line under the label, tied to the group as its description. */
  readonly hint?: string;
  /** The form field's name, when the cards sit in a form. */
  readonly name?: string;
  /** The value of the card shown as chosen. */
  readonly value: string;
  /** Called with the value of the card a person picks. */
  readonly onChange: (value: string) => void;
  /** The cards, in order. */
  readonly cards: readonly RadioCard[];
  /** True while nothing can change, such as while a choice saves. */
  readonly isDisabled?: boolean;
}

/** The cards in `props`, as one RadioGroup: the whole card picks its value. */
export function RadioCards({
  label,
  hint,
  name,
  value,
  onChange,
  cards,
  isDisabled = false,
}: RadioCardsProps) {
  return (
    <RadioGroup
      className="level-group"
      {...(name === undefined ? {} : { name })}
      value={value}
      onChange={onChange}
      isDisabled={isDisabled}
    >
      <Label className="field-label">{label}</Label>
      {hint === undefined ? null : (
        <Text slot="description" className="field-hint">
          {hint}
        </Text>
      )}
      <div className="level-options">
        {cards.map((card) => (
          <RadioField key={card.value} value={card.value} className="level-option">
            <RadioButton className="level-button">{card.label}</RadioButton>
            {card.description === undefined ? null : (
              <Text slot="description" className="level-description">
                {card.description}
              </Text>
            )}
          </RadioField>
        ))}
      </div>
    </RadioGroup>
  );
}
