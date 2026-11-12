/**
 * Protect this section, or change its protection (#116; ADR-0015 §2–3): what
 * protecting does and the higher bar it needs, the section as it reads now,
 * then a title, a why, the protection chosen, a discussion link, the voting
 * time within the entrenched bounds (#106) and "Send a Dispatch if this
 * passes" (#112). Submitting queues one `proposal` whose target is
 * `{kind: "class", atom, to}`, with no text.
 *
 * The choice is a React Aria RadioGroup of the classes `classChoices` offers
 * from the section's class now: Entrenched or Eternal for an ordinary
 * section, Make it eternal or Remove the protection for an entrenched one.
 * Choosing eternal says that it's permanent. A class Proposal holds its
 * section's slot as an edit does (ADR-0073), so while any Proposal is open on
 * the section, or once it's eternal, the route says why and shows no form.
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
import { againStartOf, lapsed, whyNoForm } from '../app/compose';
import { sectionPlace } from '../app/documentLines';
import { formatAverageLine, formatZeroLine } from '../app/format';
import { latestLink } from '../app/latestLink';
import { messages } from '../app/messages';
import { againDraft, protectDraft } from '../app/proposals';
import { composeOption } from '../engine/composeOption';
import type { Atom, GroupState, Proposal } from '../engine/fold';
import { type AtomClass, classChoices } from '../engine/rules';
import type { Draft } from '../store/drafts';
import { type ComposerProps, CurrentText, ProposalForm, Unavailable } from './Composer';

/** Props for {@link ProtectComposer}. */
export interface ProtectComposerProps {
  readonly state: GroupState;
  readonly me: string;
  /** The section to protect, from the route. */
  readonly atomId: string;
  readonly drafts: ComposerProps['drafts'];
  /** The device clock now, in ms, which the voting time's closing line counts from (#106). */
  readonly now: number;
  readonly onPropose: ComposerProps['onPropose'];
  /** A lapsed class Proposal to propose again (#74), from the `again` route. */
  readonly again?: Proposal;
  /** Whether this device's leave waits for the relay (#77): then it shows no form. */
  readonly leaving?: boolean;
}

/** A choice's name and its one line, for a section of class `from` going to `to`. */
function choiceWords(from: AtomClass, to: AtomClass) {
  const { protectChoices, protectChangeChoices } = messages.composer;
  if (from === 'ordinary') {
    return to === 'eternal' ? protectChoices.eternal : protectChoices.entrenched;
  }
  return to === 'eternal' ? protectChangeChoices.eternal : protectChangeChoices.ordinary;
}

interface ClassFieldProps {
  /** The section's class now, which picks the choices. */
  readonly from: AtomClass;
  readonly values: Draft;
  readonly onChange: (values: Draft) => void;
}

/**
 * The protection chosen (#116): a card for each class the section may go to,
 * its name over its one line, then, while eternal is chosen, that it's
 * permanent, in a polite live region so a screen reader hears it arrive. One
 * must be chosen; the draft keeps the choice.
 */
function ClassField({ from, values, onChange }: ClassFieldProps) {
  const { composer } = messages;
  return (
    <div className="stack protect-choice">
      <RadioGroup
        className="level-group"
        name="protection"
        value={values.classTo ?? null}
        onChange={(classTo) => {
          onChange({ ...values, classTo });
        }}
        isRequired
      >
        <Label className="field-label">{composer.protectLabel}</Label>
        <div className="level-options">
          {classChoices(from).map((to) => (
            <RadioField key={to} value={to} className="level-option">
              <RadioButton className="level-button">{choiceWords(from, to).name}</RadioButton>
              <Text slot="description" className="level-description">
                {choiceWords(from, to).line}
              </Text>
            </RadioField>
          ))}
        </div>
        <FieldError className="field-error">
          {from === 'ordinary' ? composer.protectMissing : composer.protectChangeMissing}
        </FieldError>
      </RadioGroup>
      <div aria-live="polite">
        {values.classTo === 'eternal' ? (
          <p className="protect-permanent">{composer.permanent}</p>
        ) : null}
      </div>
    </div>
  );
}

/** Why there's no class Proposal to write for this section, or null when there is one. */
function whyNoProtect(props: ProtectComposerProps, atom: Atom) {
  const { composer } = messages;
  const refused = whyNoForm(props);
  if (refused !== null) return refused;
  if (atom.class === 'eternal') return { title: composer.eternalTitle, text: composer.eternal };
  const option = composeOption(props.state, props.atomId);
  if (option === 'protecting') {
    return { title: composer.protectingTitle, text: composer.protecting };
  }
  return option === 'propose'
    ? null
    : { title: composer.protectBusyTitle, text: composer.protectBusy };
}

/** Where the form starts: blank, or the lapsed class Proposal's words and choice (#74). */
function formStart(state: GroupState, atomId: string, again: Proposal | undefined) {
  if (again === undefined) {
    const start = { title: '', why: '', text: '', link: latestLink(state) ?? '' };
    return { draftKey: protectDraft(atomId), start };
  }
  const chosen = again.target.kind === 'class' ? { classTo: again.target.to } : {};
  return { draftKey: againDraft(again.id), start: { ...againStartOf(state, again), ...chosen } };
}

/** The form's heading, tab title and button, for a section of class `from`. */
function wordsFor(from: AtomClass, again: Proposal | undefined) {
  const { composer } = messages;
  const changes = from === 'entrenched';
  const title = changes ? composer.protectChangeTitle : composer.protectTitle;
  return {
    title: again === undefined ? title : composer.againTitle,
    pageTitle: composer.protectPageTitle,
    submit: changes ? composer.protectChangeSubmit : composer.protectSubmit,
  };
}

/**
 * Protect this section (`#/g/{groupId}/protect/{atomId}`; #116). Its draft is
 * kept under `protect:{atomId}`, or under the lapsed class Proposal it
 * proposes again (#74).
 */
export function ProtectComposer(props: ProtectComposerProps) {
  const { state, atomId, drafts } = props;
  const { composer } = messages;
  const place = sectionPlace(state, atomId);
  if (place === null) {
    return <Unavailable state={state} title={composer.missingTitle} text={composer.missing} />;
  }
  const refused = whyNoProtect(props, place.atom);
  const back = documentBack(state, place.document.id);
  if (refused !== null) return <Unavailable state={state} {...refused} back={back} />;
  const again = lapsed(props.again);
  const { draftKey, start } = formStart(state, atomId, again);
  const from = place.atom.class;
  const bar = state.rules.bars.entrenched;
  return (
    <ProposalForm
      key={draftKey}
      state={state}
      place={{ target: { kind: 'class', atom: atomId, to: '' } }}
      draftKey={draftKey}
      start={start}
      drafts={drafts}
      now={props.now}
      onPropose={props.onPropose}
      words={wordsFor(from, again)}
      intro={
        <>
          {again === undefined ? null : <p className="lede">{composer.againLede}</p>}
          <div className="stack">
            <p className="lede">{composer.protectLede}</p>
            <p className="caption">
              {composer.protectBar(formatAverageLine(bar), formatZeroLine(bar))}
            </p>
          </div>
          <CurrentText atom={place.atom} section={place.number} />
        </>
      }
      text={null}
      field={(values, onChange) => <ClassField from={from} values={values} onChange={onChange} />}
      again={again}
      back={back}
    />
  );
}
