import { type SyntheticEvent, useRef, useState } from 'react';
import {
  Button,
  FieldError,
  Form,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
  Text,
} from 'react-aria-components';

import { messages } from '../app/messages';
import type { StewardValues } from '../app/proposals';
import { motionFor } from '../app/stewardLines';
import { MotionTitle, SuspendedNote } from '../app/stewards';
import { BackLink, Field, PageHeader } from '../app/ui';
import { can, isSuspended } from '../engine/capabilities';
import { type GroupState, TITLE_MAX, WHY_MAX } from '../engine/fold';
import { displayName } from '../engine/names';
import {
  canStand,
  mayProposeSteward,
  seatAt,
  type SeatNumber,
  seatTakesElection,
} from '../engine/stewards';
import { nfcLength } from '../engine/text';

/** How sending went: `proposed` moves on to the Proposal; the others stay on the form. */
export type StewardOutcome = 'proposed' | 'too-large' | 'failed';

/** Props for {@link StewardComposer}. */
export interface StewardComposerProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** The seat, from the route. */
  readonly seat: SeatNumber;
  /** True for a recall of the seat's steward, false for an election (#102). */
  readonly recall: boolean;
  /** Queues the steward Proposal from valid entries. */
  readonly onPropose: (values: StewardValues) => Promise<StewardOutcome>;
}

/** Limits count code points after NFC (spec §4), never UTF-16 units. */
function required(missing: string, max: number, tooLong: string) {
  return (value: string): string | null => {
    const text = value.trim();
    if (text === '') return missing;
    return nfcLength(text) > max ? tooLong : null;
  };
}

const checkTitle = required(
  messages.composer.titleMissing,
  TITLE_MAX,
  messages.composer.titleTooLong(TITLE_MAX),
);
const checkWhy = required(
  messages.composer.whyMissing,
  WHY_MAX,
  messages.composer.whyTooLong(WHY_MAX),
);

/** The screen without a form: why there's nothing to propose here. */
function Unavailable({ state, me, text }: { state: GroupState; me: string; text: string }) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader
        title={messages.stewards.unavailableTitle}
        pageTitle={messages.stewards.composerPageTitle}
      />
      {isSuspended(state, me) ? (
        <SuspendedNote state={state} me={me} />
      ) : (
        <p className="lede">{text}</p>
      )}
    </main>
  );
}

/** Runs `onPropose` once at a time; what was proposed leaves this screen, so the button stays off. */
function useSend(onPropose: StewardComposerProps['onPropose']) {
  const busy = useRef(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const run = async (values: StewardValues) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setFailed(false);
    setRefused({});
    const outcome = await onPropose(values).catch(() => 'failed' as const);
    if (outcome === 'proposed') return;
    busy.current = false;
    setRunning(false);
    setRefused(outcome === 'too-large' ? { why: messages.composer.tooLarge } : {});
    setFailed(outcome === 'failed');
  };
  return { run, running, failed, refused };
}

interface NomineesProps {
  readonly state: GroupState;
  readonly seat: SeatNumber;
  readonly value: string | null;
  readonly onChange: (member: string) => void;
}

/** Who can stand for the seat, as a React Aria RadioGroup of names, one of which must be chosen. */
function Nominees({ state, seat, value, onChange }: NomineesProps) {
  const standing = state.members.filter((m) => canStand(state, seat, m.author));
  return (
    <RadioGroup className="level-group" name="nominee" value={value} onChange={onChange} isRequired>
      <Label className="field-label">{messages.stewards.nomineeLabel}</Label>
      <Text slot="description" className="field-hint">
        {messages.stewards.nomineeHint}
      </Text>
      <div className="level-options">
        {standing.map((m) => (
          <RadioField key={m.author} value={m.author} className="level-option">
            <RadioButton className="level-button">
              <bdi>{displayName(state, m.author)}</bdi>
            </RadioButton>
          </RadioField>
        ))}
      </div>
      <FieldError className="field-error">{messages.stewards.nomineeMissing}</FieldError>
    </RadioGroup>
  );
}

/** The steward a recall would remove, as the ballot will put it, and what passing does. */
function RecallOf({ state, seat }: { readonly state: GroupState; readonly seat: SeatNumber }) {
  const motion = motionFor(state, { seat, member: null, holder: seatAt(state, seat).holder });
  return (
    <div className="card">
      <p className="eyebrow">{messages.proposal.onBallot}</p>
      <p className="heading-3">
        <MotionTitle motion={motion} />
      </p>
      <p className="caption">{messages.stewards.recallLine}</p>
    </div>
  );
}

/** The ballot line a nominee's election starts its title as. */
function electionTitle(state: GroupState, seat: SeatNumber, member: string): string {
  return messages.stewards.makeStewardTitle(displayName(state, member) ?? '', seat);
}

/** Where a recall's title starts: what its ballot will say. */
function recallTitle(state: GroupState, seat: SeatNumber): string {
  const holder = seatAt(state, seat).holder ?? '';
  return messages.stewards.recallStewardTitle(displayName(state, holder) ?? '');
}

interface FormProps {
  readonly state: GroupState;
  readonly seat: SeatNumber;
  readonly recall: boolean;
  readonly onPropose: StewardComposerProps['onPropose'];
}

/**
 * The form: the nominee (or, for a recall, the steward it names), a title
 * that starts as the ballot's line until the person types their own, and a
 * why. Submitting queues one steward `proposal`.
 */
function StewardForm({ state, seat, recall, onPropose }: FormProps) {
  const [member, setMember] = useState<string | null>(null);
  const [title, setTitle] = useState(recall ? recallTitle(state, seat) : '');
  const [edited, setEdited] = useState(false);
  const [why, setWhy] = useState('');
  const { run, running, failed, refused } = useSend(onPropose);
  const { stewards } = messages;
  const choose = (picked: string) => {
    setMember(picked);
    if (!edited) setTitle(electionTitle(state, seat, picked));
  };
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!recall && member === null) return;
    void run({ seat, member: recall ? null : member, title: title.trim(), why: why.trim() });
  };
  return (
    <Form className="form" onSubmit={submit} validationErrors={refused}>
      {recall ? (
        <RecallOf state={state} seat={seat} />
      ) : (
        <Nominees state={state} seat={seat} value={member} onChange={choose} />
      )}
      <Field
        name="title"
        label={messages.composer.titleLabel}
        hint={stewards.titleHint}
        autoComplete="off"
        isRequired
        validate={checkTitle}
        value={title}
        onChange={(text) => {
          setEdited(true);
          setTitle(text);
        }}
      />
      <Field
        name="why"
        label={messages.composer.whyLabel}
        hint={stewards.whyHint}
        multiline
        isRequired
        validate={checkWhy}
        value={why}
        onChange={setWhy}
      />
      <p className="caption">{stewards.visibility}</p>
      {failed ? (
        <p role="alert" className="form-error">
          {stewards.failed}
        </p>
      ) : null}
      <div className="row form-actions">
        <Button type="submit" className="button button-primary" isDisabled={running}>
          {recall ? stewards.recallSubmit : stewards.submit}
        </Button>
      </div>
    </Form>
  );
}

/** Why there's no form for this seat now, or null when there is one. */
function unavailable(props: StewardComposerProps): string | null {
  const { state, me, seat, recall } = props;
  if (!can(state, me, 'propose')) return messages.stewards.notAllowed;
  const open = recall
    ? mayProposeSteward(state, me, { seat, member: null })
    : seatTakesElection(state, seat);
  if (!open) return messages.stewards.unavailable;
  const standing = state.members.some((m) => canStand(state, seat, m.author));
  return recall || standing ? null : messages.stewards.noNominees;
}

/**
 * The steward composer (`#/g/{groupId}/steward/{seat}` and `…/recall/{seat}`;
 * ADR-0049, #102): Propose a steward names someone who can stand for the
 * seat, and Propose recall names its steward. Either is an ordinary Proposal
 * whose ballot reads "Make <name> steward (seat N)" or "Recall <name> as
 * steward". It shows a form only where the fold would accept one
 * (stewards.ts), and says why otherwise.
 */
export function StewardComposer(props: StewardComposerProps) {
  const { state, me, seat, recall } = props;
  const reason = unavailable(props);
  if (reason !== null) return <Unavailable state={state} me={me} text={reason} />;
  const { stewards } = messages;
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader
        eyebrow={stewards.heading}
        title={recall ? stewards.recallTitle(seat) : stewards.composerTitle(seat)}
        pageTitle={recall ? stewards.recallPageTitle : stewards.composerPageTitle}
      />
      <p className="lede">{stewards.about(state.rules.suspensionDays)}</p>
      <StewardForm
        key={`${String(seat)}-${String(recall)}`}
        state={state}
        seat={seat}
        recall={recall}
        onPropose={props.onPropose}
      />
    </main>
  );
}
