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
  VisuallyHidden,
} from 'react-aria-components';

import type { Score } from '../engine/event';
import { NOTE_MAX } from '../engine/fold';
import { nfcLength } from '../engine/text';
import { messages } from './messages';
import { SendStatus } from './SendStatus';
import { Field } from './ui';

/** Props for {@link Ballot}. */
export interface BallotProps {
  /** The score this voter's latest ballot gave, or null before they vote. */
  readonly initialScore: Score | null;
  /** That ballot's note, or `''`. */
  readonly initialNote: string;
  /** Whether this voter has a ballot already, sent or waiting to send. */
  readonly hasVoted: boolean;
  /** True once voting has closed, by the relay's time. */
  readonly isDisabled: boolean;
  /** Whether this voter's latest ballot is still in the outbox. */
  readonly pending: boolean;
  /** Whether the last sync pass reached the relay. */
  readonly reachable: boolean;
  /** Queues the ballot; rejects when it couldn't be saved. */
  readonly onVote: (score: Score, note: string) => Promise<void>;
}

const SCORES: readonly Score[] = [0, 1, 2, 3, 4];

function toScore(value: string | null): Score | null {
  return SCORES.find((score) => String(score) === value) ?? null;
}

/** The note counts code points after NFC, as the fold does (spec §4), not UTF-16 units. */
function noteProblem(note: string, score: Score | null): string | null {
  const trimmed = note.trim();
  if (nfcLength(trimmed) > NOTE_MAX) return messages.ballot.noteTooLong(NOTE_MAX);
  return score === 0 && trimmed === '' ? messages.ballot.noteMissing : null;
}

/** One pill: its number on the score's color, then its label, read as "0 · Strongly opposed". */
function ScorePill({ score }: { readonly score: Score }) {
  return (
    <RadioField value={String(score)} className="score-field">
      <RadioButton className={`score-pill score-pill-${String(score)}`}>
        <span className="score-number">{score}</span>{' '}
        <VisuallyHidden>{messages.ballot.separator}</VisuallyHidden>{' '}
        <span className="score-label">{messages.ballot.scores[score]}</span>
      </RadioButton>
    </RadioField>
  );
}

/** Runs `vote` once at a time, and says how the last run went. */
function useVote(onVote: BallotProps['onVote']) {
  const busy = useRef(false);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<'none' | 'sent' | 'failed'>('none');
  const vote = async (score: Score, note: string) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setOutcome('none');
    const saved = await onVote(score, note).then(
      () => true,
      () => false,
    );
    busy.current = false;
    setRunning(false);
    setOutcome(saved ? 'sent' : 'failed');
  };
  return { vote, running, outcome };
}

/**
 * The ballot (DESIGN.md, Ballot; spec §8): five score pills in a React Aria
 * RadioGroup, each always showing its number and label, and one note, which
 * becomes a required reason when the score is 0 (ADR-0002). Sending again
 * before the close replaces the earlier ballot.
 */
export function Ballot(props: BallotProps) {
  const { initialScore, initialNote, hasVoted, isDisabled, pending, reachable } = props;
  const [value, setValue] = useState<string | null>(
    initialScore === null ? null : String(initialScore),
  );
  const [note, setNote] = useState(initialNote);
  const { vote, running, outcome } = useVote(props.onVote);
  const score = toScore(value);
  const forZero = score === 0;

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (score !== null && noteProblem(note, score) === null) void vote(score, note);
  };

  return (
    <Form className="ballot" onSubmit={submit}>
      {isDisabled ? <p className="caption">{messages.ballot.closed}</p> : null}
      <RadioGroup
        className="score-group"
        name="score"
        value={value}
        onChange={setValue}
        isRequired
        isDisabled={isDisabled}
      >
        <Label className="field-label">{messages.ballot.scoreLabel}</Label>
        <Text slot="description" className="field-hint">
          {messages.ballot.visibility}
        </Text>
        <div className="score-pills">
          {SCORES.map((option) => (
            <ScorePill key={option} score={option} />
          ))}
        </div>
        <FieldError className="field-error">{messages.ballot.scoreMissing}</FieldError>
      </RadioGroup>
      {isDisabled && note.trim() === '' ? null : (
        <Field
          // A fresh field when the reason stops (or starts) being required, so a stale
          // "Add your reason" never lingers until blur and moves Send under the pointer.
          key={forZero ? 'reason' : 'note'}
          name="note"
          label={forZero ? messages.ballot.reasonLabel : messages.ballot.noteLabel}
          multiline
          value={note}
          onChange={setNote}
          isRequired={forZero}
          isDisabled={isDisabled}
          validate={(text) => noteProblem(text, score)}
        />
      )}
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {messages.ballot.failed}
        </p>
      ) : null}
      <div className="row ballot-send">
        {isDisabled ? null : (
          <Button type="submit" className="button button-primary" isDisabled={running}>
            {hasVoted ? messages.ballot.update : messages.ballot.submit}
          </Button>
        )}
        <SendStatus pending={pending} reachable={reachable} sent={outcome === 'sent'} />
      </div>
    </Form>
  );
}
