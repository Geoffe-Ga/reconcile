import { type ReactNode, type SyntheticEvent, useId, useState } from 'react';
import {
  Button,
  FieldError,
  Form,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
  VisuallyHidden,
} from 'react-aria-components';

import type { Score } from '../engine/event';
import { NOTE_MAX } from '../engine/fold';
import { nfcLength } from '../engine/text';
import { copiedNote } from '../store/carry';
import { holdPresses } from './holdPresses';
import { messages } from './messages';
import { ChoiceList } from './Options';
import { SendStatus } from './SendStatus';
import { Field } from './ui';
import { useSaving } from './useSaving';
import type { VersionView } from './versionViews';

/**
 * Whether a version is the one card of a ballot that decides something other
 * than a section's text (a steward, an opt-in, dissolving, a member's
 * removal, or a coalition, #102, #117, #108, #115, #114), whose pills read
 * "Your score".
 */
function decidesOne(version: VersionView): boolean {
  const { steward, rules, dissolve, removal, decision } = version;
  return [steward, rules, dissolve, removal, decision].some((field) => field !== undefined);
}

/** A score for each version, by version id. */
export type Scores = Readonly<Record<string, Score>>;

/** Props for {@link Ballot}. */
export interface BallotProps {
  /** The versions on the ballot, in ballot order. */
  readonly versions: readonly VersionView[];
  /** The section's text now, which each version is compared with, or null to show each alone. */
  readonly current: string | null;
  /** The scores this voter's latest ballot gave, by version id, or none before they vote. */
  readonly initialScores: Scores;
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
  /** Queues the ballot: a score for every version, and one note. Rejects when it couldn't be saved. */
  readonly onVote: (scores: Scores, note: string) => Promise<void>;
  /** What goes under each version's pills, such as its consent meter. */
  readonly below?: (version: VersionView) => ReactNode;
  /**
   * `versions` shows each version with its change (the default); `options`
   * shows a priority vote's options as plain text (#107).
   */
  readonly layout?: 'versions' | 'options';
  /** Why a disabled ballot can't change, in place of "Voting has closed", such as a suspension (#102). */
  readonly disabledNote?: ReactNode;
  /**
   * Notes this person wrote on the same Dispatch in their other groups
   * (#126): the note may not repeat one, so the two can't be matched.
   */
  readonly refusedNotes?: readonly string[];
}

const SCORES: readonly Score[] = [0, 1, 2, 3, 4];

/** No notes refused: every ballot that isn't on a Dispatch rising from another group. */
const NONE_REFUSED: readonly string[] = [];

function toScore(value: string | null): Score | null {
  return SCORES.find((score) => String(score) === value) ?? null;
}

/**
 * The note counts code points after NFC, as the fold does (spec §4), not
 * UTF-16 units, and may not repeat a note in `refused` (#126).
 */
function noteProblem(
  note: string,
  needsReason: boolean,
  refused: readonly string[],
): string | null {
  const trimmed = note.trim();
  if (nfcLength(trimmed) > NOTE_MAX) return messages.ballot.noteTooLong(NOTE_MAX);
  if (copiedNote(trimmed, refused)) return messages.ballot.copiedNote;
  return needsReason && trimmed === '' ? messages.ballot.noteMissing : null;
}

/** The scores chosen so far for the ballot's versions, leaving out any version not on it. */
function scoresOn(versions: readonly VersionView[], chosen: Scores): Record<string, Score> {
  return Object.fromEntries(
    versions.flatMap((version) => {
      const score = chosen[version.id];
      return score === undefined ? [] : [[version.id, score] as const];
    }),
  );
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

interface ScoreGroupProps {
  readonly version: VersionView;
  /** The group's label: "Score for version N", or "Score for <option>". */
  readonly label: ReactNode;
  readonly score: Score | undefined;
  /** The id of the line that says who sees the scores. */
  readonly hint: string;
  readonly isDisabled: boolean;
  readonly onChange: (score: Score) => void;
}

/** One version's five pills, in a React Aria RadioGroup labelled "Score for version N". */
function ScoreGroup({ version, label, score, hint, isDisabled, onChange }: ScoreGroupProps) {
  return (
    <RadioGroup
      className="score-group"
      name={`score-${version.id}`}
      value={score === undefined ? null : String(score)}
      onChange={(value) => {
        const chosen = toScore(value);
        if (chosen !== null) onChange(chosen);
      }}
      isRequired
      isDisabled={isDisabled}
      aria-describedby={hint}
    >
      <Label className="field-label">{label}</Label>
      <div className="score-pills">
        {SCORES.map((option) => (
          <ScorePill key={option} score={option} />
        ))}
      </div>
      <FieldError className="field-error">{messages.ballot.scoreMissing}</FieldError>
    </RadioGroup>
  );
}

/** What the note asks for: a reason for any 0, else what would make a 1 a 3, else anything. */
type NoteAsk = 'reason' | 'better' | 'note';

const NOTE_LABELS: Readonly<Record<NoteAsk, string>> = {
  reason: messages.ballot.reasonLabel,
  better: messages.ballot.betterLabel,
  note: messages.ballot.noteLabel,
};

/** A 0 needs a reason (ADR-0002); a 1 with no 0 asks what would make it a 3 (spec §8). */
function noteAsk(scores: Scores): NoteAsk {
  const given = Object.values(scores);
  if (given.includes(0)) return 'reason';
  return given.includes(1) ? 'better' : 'note';
}

interface BallotNoteProps {
  readonly note: string;
  /** What the note asks for; only a reason for a 0 is required. */
  readonly ask: NoteAsk;
  readonly isDisabled: boolean;
  readonly onChange: (note: string) => void;
  /** Notes it may not repeat (#126). */
  readonly refused: readonly string[];
}

/** The ballot's one note, or nothing on a closed ballot that has none. */
function BallotNote({ note, ask, isDisabled, onChange, refused }: BallotNoteProps) {
  if (isDisabled && note.trim() === '') return null;
  const forZero = ask === 'reason';
  return (
    <Field
      // A fresh field when the reason stops (or starts) being required, so a stale
      // "Add your reason" never lingers until blur and moves Send under the pointer.
      key={forZero ? 'reason' : 'note'}
      name="note"
      label={NOTE_LABELS[ask]}
      multiline
      value={note}
      onChange={onChange}
      isRequired={forZero}
      isDisabled={isDisabled}
      validate={(text) => noteProblem(text, forZero, refused)}
    />
  );
}

/**
 * "Score for version N", a steward, rules, dissolve, member removal or
 * coalition ballot's own label (#102, #117, #108, #115, #114), or for a
 * priority option, "Score for <option>" with the option in `<bdi>` (#107).
 */
function scoreLabel(version: VersionView, layout: BallotProps['layout']): ReactNode {
  if (layout === 'options') {
    return (
      <>
        {messages.ballot.scoreForOption} <bdi>{version.text}</bdi>
      </>
    );
  }
  return decidesOne(version) ? messages.stewards.score : messages.ballot.scoreFor(version.number);
}

/**
 * What the ballot says above its versions: why it can't change once closed,
 * or that a version was added since this voter's ballot.
 */
function BallotNotices({ props, missing }: { props: BallotProps; missing: boolean }) {
  const { isDisabled, hasVoted } = props;
  if (isDisabled) return props.disabledNote ?? <p className="caption">{messages.ballot.closed}</p>;
  return hasVoted && missing ? <p className="ballot-notice">{messages.ballot.newVersion}</p> : null;
}

/**
 * The ballot (DESIGN.md, Ballot; spec §8): every version side by side, each
 * with its word diff and five score pills in a React Aria RadioGroup that
 * always shows each pill's number and label, then one note for the whole
 * ballot, which becomes a required reason when any score is 0 (ADR-0002) and
 * asks "What would make this a 3 for you?" when a score is 1 and none is 0.
 * Every version needs a score. Sending again before the close replaces the
 * earlier ballot in full, so a voter whose latest ballot misses a version
 * added since is asked to score it, with their earlier scores kept. A
 * priority vote's ballot shows its options instead, each with its own pills.
 */
export function Ballot(props: BallotProps) {
  const { versions, current, initialScores, hasVoted, isDisabled, pending, reachable } = props;
  const [chosen, setChosen] = useState<Scores>(initialScores);
  const [note, setNote] = useState(props.initialNote);
  const { run: vote, running, outcome } = useSaving(props.onVote);
  const hint = useId();
  const scores = scoresOn(versions, chosen);
  const ask = noteAsk(scores);
  const forZero = ask === 'reason';
  const complete = Object.keys(scores).length === versions.length;
  const missing = versions.some((version) => !Object.hasOwn(initialScores, version.id));

  const refused = props.refusedNotes ?? NONE_REFUSED;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (complete && noteProblem(note, forZero, refused) === null) void vote(scores, note);
  };

  return (
    <Form className="ballot" onSubmit={submit}>
      <BallotNotices props={props} missing={missing} />
      <p id={hint} className="field-hint">
        {messages.ballot.visibility}
      </p>
      <ChoiceList versions={versions} current={current} layout={props.layout ?? 'versions'}>
        {(version) => (
          <>
            <ScoreGroup
              version={version}
              label={scoreLabel(version, props.layout)}
              score={scores[version.id]}
              hint={hint}
              isDisabled={isDisabled}
              onChange={(score) => {
                setChosen((now) => ({ ...now, [version.id]: score }));
              }}
            />
            {props.below?.(version)}
          </>
        )}
      </ChoiceList>
      <BallotNote
        note={note}
        ask={ask}
        isDisabled={isDisabled}
        onChange={setNote}
        refused={refused}
      />
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {messages.ballot.failed}
        </p>
      ) : null}
      <div className="row ballot-send" onPointerDownCapture={holdPresses(running)}>
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
