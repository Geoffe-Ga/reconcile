/**
 * Move this section (#103; spec §8): a title, a why, where the section goes,
 * a discussion link, the voting time (#106) and "Send a Dispatch if this
 * passes" (#112), beside the section as it reads now. Submitting queues one
 * `proposal` whose target is `{kind: "move", atom, after}`, with no text.
 *
 * Where it goes is a React Aria RadioGroup: "Put it first", then "Put it
 * after: <first words>" for each other section of the same Document. The
 * section's own spot shows, but can't be chosen. A move holds its section's
 * slot as an edit does (ADR-0073), so while any Proposal is open on the
 * section, or it has nowhere else to go, the route says why and shows no form.
 */
import {
  FieldError,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
  Text,
} from 'react-aria-components';

import { documentBack } from '../app/backLinks';
import { againStartOf, lapsed, whyNoForm, whySectionWaits } from '../app/compose';
import { sectionPlace } from '../app/documentLines';
import { latestLink } from '../app/latestLink';
import { messages } from '../app/messages';
import { againDraft, moveDraft } from '../app/proposals';
import { firstWords } from '../app/text/firstWords';
import { composeOption } from '../engine/composeOption';
import { atomsOf } from '../engine/documents';
import type { Atom, GroupState, Proposal } from '../engine/fold';
import type { Draft } from '../store/drafts';
import {
  type ComposerProps,
  CurrentText,
  EntrenchedNote,
  ProposalForm,
  Unavailable,
} from './Composer';

/** Props for {@link MoveComposer}. */
export interface MoveComposerProps {
  readonly state: GroupState;
  readonly me: string;
  /** The section to move, from the route. */
  readonly atomId: string;
  readonly drafts: ComposerProps['drafts'];
  /** The device clock now, in ms, which the voting time's closing line counts from (#106). */
  readonly now: number;
  readonly onPropose: ComposerProps['onPropose'];
  /** A lapsed move to propose again (#74), from the `again` route. */
  readonly again?: Proposal;
  /** Whether this device's leave waits for the relay (#77): then it shows no form. */
  readonly leaving?: boolean;
}

/** "Put it first" as the RadioGroup holds it: no Atom id starts with a colon. */
const FIRST = ':first';

/** The RadioGroup's value for a draft's place: none until one is chosen. */
function placeValue(moveAfter: Draft['moveAfter']): string | null {
  if (moveAfter === undefined) return null;
  return moveAfter ?? FIRST;
}

interface PlaceFieldProps {
  /** The section that moves. */
  readonly atom: Atom;
  /** Every section of its Document, in order. */
  readonly sections: readonly Atom[];
  readonly values: Draft;
  readonly onChange: (values: Draft) => void;
}

/** One place the section could go: first, or after `after`, its own spot shown but not chosen. */
function PlaceOption({ value, here, after }: { value: string; here: boolean; after?: Atom }) {
  const { composer } = messages;
  return (
    <RadioField
      value={value}
      className={here ? 'level-option place-here' : 'level-option'}
      isDisabled={here}
    >
      <RadioButton className="level-button">
        {after === undefined ? (
          composer.moveFirst
        ) : (
          <span>
            {composer.moveAfter} <bdi>{firstWords(after.text)}</bdi>
          </span>
        )}
      </RadioButton>
      {here ? (
        <Text slot="description" className="level-description">
          {composer.moveHere}
        </Text>
      ) : null}
    </RadioField>
  );
}

/**
 * Where the section goes (#103): "Put it first", then after each other
 * section of its Document, with the spot it holds now shown but disabled.
 * One must be chosen; the draft keeps the choice.
 */
function PlaceField({ atom, sections, values, onChange }: PlaceFieldProps) {
  const { composer } = messages;
  const index = sections.findIndex((section) => section.id === atom.id);
  const before = sections[index - 1]?.id ?? FIRST;
  const pick = (value: string) => {
    onChange({ ...values, moveAfter: value === FIRST ? null : value });
  };
  return (
    <RadioGroup
      className="level-group"
      name="place"
      value={placeValue(values.moveAfter)}
      onChange={pick}
      isRequired
    >
      <Label className="field-label">{composer.movePlaceLabel}</Label>
      <div className="level-options">
        <PlaceOption value={FIRST} here={before === FIRST} />
        {sections
          .filter((section) => section.id !== atom.id)
          .map((section) => (
            <PlaceOption
              key={section.id}
              value={section.id}
              here={before === section.id}
              after={section}
            />
          ))}
      </div>
      <FieldError className="field-error">{composer.movePlaceMissing}</FieldError>
    </RadioGroup>
  );
}

/** Why there's no move to write for this section, or null when there is one. */
function whyNoMove(props: MoveComposerProps, sections: readonly Atom[]) {
  const { composer } = messages;
  const refused = whyNoForm(props) ?? whySectionWaits(props.state, props.atomId);
  if (refused !== null) return refused;
  if (composeOption(props.state, props.atomId) !== 'propose') {
    return { title: composer.moveBusyTitle, text: composer.moveBusy };
  }
  return sections.length < 2 ? { title: composer.moveAloneTitle, text: composer.moveAlone } : null;
}

/** Where the form starts: blank, or the lapsed move's words and place (#74). */
function formStart(state: GroupState, atomId: string, again: Proposal | undefined) {
  if (again === undefined) {
    const start = { title: '', why: '', text: '', link: latestLink(state) ?? '' };
    return { draftKey: moveDraft(atomId), start };
  }
  const after = again.target.kind === 'move' ? again.target.after : null;
  return {
    draftKey: againDraft(again.id),
    start: { ...againStartOf(state, again), moveAfter: after },
  };
}

/**
 * Move this section (`#/g/{groupId}/move/{atomId}`; #103). Its draft is kept
 * under `move:{atomId}`, or under the lapsed move it proposes again (#74).
 */
export function MoveComposer(props: MoveComposerProps) {
  const { state, atomId, drafts } = props;
  const { composer } = messages;
  const place = sectionPlace(state, atomId);
  if (place === null) {
    return <Unavailable state={state} title={composer.missingTitle} text={composer.missing} />;
  }
  const sections = atomsOf(state, place.document.id);
  const refused = whyNoMove(props, sections);
  const back = documentBack(state, place.document.id);
  if (refused !== null) return <Unavailable state={state} {...refused} back={back} />;
  const again = lapsed(props.again);
  const { draftKey, start } = formStart(state, atomId, again);
  return (
    <ProposalForm
      key={draftKey}
      state={state}
      place={{ target: { kind: 'move', atom: atomId, after: null } }}
      draftKey={draftKey}
      start={start}
      drafts={drafts}
      now={props.now}
      onPropose={props.onPropose}
      words={{
        title: again === undefined ? composer.moveTitle : composer.againTitle,
        pageTitle: composer.movePageTitle,
        submit: composer.moveSubmit,
      }}
      intro={
        <>
          {again === undefined ? null : <p className="lede">{composer.againLede}</p>}
          <p className="lede">{composer.moveLede}</p>
          <EntrenchedNote state={state} atom={place.atom} />
          <CurrentText atom={place.atom} section={place.number} />
        </>
      }
      text={null}
      field={(values, onChange) => (
        <PlaceField atom={place.atom} sections={sections} values={values} onChange={onChange} />
      )}
      again={again}
      back={back}
    />
  );
}
