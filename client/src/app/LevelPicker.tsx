import { Label, Link, RadioButton, RadioField, RadioGroup, Text } from 'react-aria-components';

import { type Level, LEVELS } from '../engine/capabilities';
import { levelDescription, levelName } from './levels';
import { messages } from './messages';
import { routeHref } from './router';

/** Props for {@link LevelPicker}. */
export interface LevelPickerProps {
  /** The level shown as chosen. */
  readonly value: Level;
  /** Called with the level a person picks. */
  readonly onChange: (level: Level) => void;
  /** True while nothing can change, such as while a choice saves. */
  readonly isDisabled?: boolean;
}

/**
 * How involved a person is in a group (ADR-0003, ADR-0021): a React Aria
 * RadioGroup of the three levels, in `LEVELS` order, each with its one line
 * tied to it as a description. The whole card picks its level. It only
 * reports the choice: Join and People decide what a choice does.
 */
export function LevelPicker({ value, onChange, isDisabled = false }: LevelPickerProps) {
  const pick = (picked: string) => {
    const level = LEVELS.find((candidate) => candidate === picked);
    if (level !== undefined) onChange(level);
  };
  return (
    <RadioGroup className="level-group" value={value} onChange={pick} isDisabled={isDisabled}>
      <Label className="field-label">{messages.levels.label}</Label>
      <Text slot="description" className="field-hint">
        {messages.levels.hint}
      </Text>
      <div className="level-options">
        {LEVELS.map((level) => (
          <RadioField key={level} value={level} className="level-option">
            <RadioButton className="level-button">{levelName(level)}</RadioButton>
            <Text slot="description" className="level-description">
              {levelDescription(level)}
            </Text>
          </RadioField>
        ))}
      </div>
    </RadioGroup>
  );
}

/** "Change your involvement →": to Group home, where the People list holds the picker. */
export function ChangeInvolvement({ groupId }: { readonly groupId: string }) {
  return (
    <Link className="forward-link" href={routeHref({ name: 'group', groupId })}>
      {messages.levels.change}
      <span aria-hidden="true">{messages.app.forward}</span>
    </Link>
  );
}
