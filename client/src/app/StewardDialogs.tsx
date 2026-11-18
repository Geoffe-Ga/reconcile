/**
 * The two ways a person writes to Reconcile's steward (#490;
 * docs/spec/listed-doors.md §6.3), each a React Aria modal dialog behind a
 * quiet button:
 *
 * - {@link ReportDialog}, "Report this entry", on a shelf entry's page: which
 *   covenant clause it breaks, and an optional note of up to 500 code
 *   points. It says that a report names no one, gets no reply and hides
 *   nothing by itself.
 * - {@link AppealDialog}, "Ask the steward to look again", on Group home for
 *   a member who may propose while the group's listing, or an entry, is held
 *   or removed: why it should show, up to 500 code points.
 *
 * Send seals and PUTs one box (`shelf/report.ts`) and closes; a status line
 * then says it went. A send that fails keeps the dialog open with the reason.
 */
import { type ReactNode, type SyntheticEvent, useState } from 'react';
import {
  Button,
  Dialog,
  DialogTrigger,
  Form,
  Heading,
  Label,
  Modal,
  ModalOverlay,
  RadioButton,
  RadioField,
  RadioGroup,
} from 'react-aria-components';

import { codePointLength } from '../engine/text';
import { CLAUSE_WORDS } from '../shelf/covenant';
import type { Clause } from '../shelf/record';
import { APPEAL_NOTE_MAX, NOTE_MAX } from '../shelf/report';
import { holdPresses } from './holdPresses';
import { messages } from './messages';
import { Field } from './ui';
import { useSaving } from './useSaving';

/** Whether a send reached the relay. */
export type SendOutcome = 'sent' | 'failed';

const words = messages.shelfEntry;
const CLAUSES: readonly Clause[] = ['C1', 'C2', 'C3'];

/** What one note form shows and does. */
interface NoteFormProps {
  readonly title: string;
  readonly lede: string;
  readonly label: string;
  readonly hint: string;
  readonly max: number;
  readonly required: boolean;
  /** Fields above the note, such as the clause. */
  readonly children?: ReactNode;
  readonly onSend: (note: string) => Promise<SendOutcome>;
  /** Closes the dialog, sent or not. */
  readonly close: () => void;
  /** Says it was sent, once the relay has it. */
  readonly onSent: () => void;
}

/** The note's error: too long, or blank where one is needed. */
function noteProblem(note: string, max: number, required: boolean): string | null {
  const trimmed = note.trim().normalize('NFC');
  if (codePointLength(trimmed) > max) return words.noteTooLong(max);
  return required && trimmed === '' ? words.appealRequired : null;
}

/** The dialog's form: its title and lede, any fields above, the note, then Send or Cancel. */
function NoteForm(props: NoteFormProps) {
  const { max, required, close } = props;
  const [note, setNote] = useState('');
  const { run, running, outcome } = useSaving(async (text: string) => {
    if ((await props.onSend(text)) !== 'sent') throw new Error('Not sent.');
  });
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (noteProblem(note, max, required) !== null) return;
    void run(note).then((sent) => {
      if (!sent) return;
      props.onSent();
      close();
    });
  };
  return (
    <Form className="form dialog-form" onSubmit={submit}>
      <Heading slot="title" className="dialog-title">
        {props.title}
      </Heading>
      <p className="lede">{props.lede}</p>
      {props.children}
      <Field
        name="note"
        label={props.label}
        hint={props.hint}
        multiline
        value={note}
        onChange={setNote}
        isRequired={required}
        validate={(value) => noteProblem(value, max, required)}
      />
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {words.sendFailed}
        </p>
      ) : null}
      <div className="row form-actions" onPointerDownCapture={holdPresses(running)}>
        <Button type="submit" className="button button-primary" isDisabled={running}>
          {running ? words.sending : words.send}
        </Button>
        <Button className="button button-secondary" onPress={close} isDisabled={running}>
          {words.cancel}
        </Button>
      </div>
    </Form>
  );
}

/** Props for {@link Quiet}. */
interface QuietProps {
  readonly label: string;
  readonly sentLine: string;
  readonly form: (close: () => void, sent: () => void) => ReactNode;
}

/** A quiet button that opens a modal holding `form`, and the line once it was sent. */
function Quiet({ label, sentLine, form }: QuietProps) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <div className="stack">
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        <Button className="button button-quiet">{label}</Button>
        <ModalOverlay className="modal-overlay" isDismissable>
          <Modal className="modal">
            <Dialog className="dialog">
              {({ close }) =>
                form(close, () => {
                  setSent(true);
                })
              }
            </Dialog>
          </Modal>
        </ModalOverlay>
      </DialogTrigger>
      <p className="status" role="status">
        {sent ? sentLine : null}
      </p>
    </div>
  );
}

/** Props for {@link ReportDialog}. */
export interface ReportDialogProps {
  /** Sends the report under `clause` with `note`, blank for none. */
  readonly onReport: (clause: Clause, note: string) => Promise<SendOutcome>;
}

/** Report this entry: a clause and an optional note, sent to the steward. */
export function ReportDialog({ onReport }: ReportDialogProps) {
  const [clause, setClause] = useState<Clause>('C2');
  return (
    <Quiet
      label={words.report}
      sentLine={words.reportSent}
      form={(close, sent) => (
        <NoteForm
          title={words.reportTitle}
          lede={words.reportLede}
          label={words.noteLabel}
          hint={words.noteHint(NOTE_MAX)}
          max={NOTE_MAX}
          required={false}
          onSend={(note) => onReport(clause, note)}
          close={close}
          onSent={sent}
        >
          <RadioGroup
            className="level-group"
            value={clause}
            onChange={(value) => {
              const picked = CLAUSES.find((c) => c === value);
              if (picked !== undefined) setClause(picked);
            }}
          >
            <Label className="field-label">{words.reportClause}</Label>
            <div className="level-options">
              {CLAUSES.map((c) => (
                <RadioField key={c} value={c} className="level-option">
                  <RadioButton className="level-button">
                    {messages.shelfSteward.clauseOption(c, CLAUSE_WORDS[c])}
                  </RadioButton>
                </RadioField>
              ))}
            </div>
          </RadioGroup>
        </NoteForm>
      )}
    />
  );
}

/** Props for {@link AppealDialog}. */
export interface AppealDialogProps {
  /** Sends the appeal with `note`. */
  readonly onAppeal: (note: string) => Promise<SendOutcome>;
}

/** Ask the steward to look again: why it should show, sent to the steward. */
export function AppealDialog({ onAppeal }: AppealDialogProps) {
  return (
    <Quiet
      label={words.appeal}
      sentLine={words.appealSent}
      form={(close, sent) => (
        <NoteForm
          title={words.appealTitle}
          lede={words.appealLede}
          label={words.appealLabel}
          hint={words.appealHint(APPEAL_NOTE_MAX)}
          max={APPEAL_NOTE_MAX}
          required
          onSend={onAppeal}
          close={close}
          onSent={sent}
        />
      )}
    />
  );
}
