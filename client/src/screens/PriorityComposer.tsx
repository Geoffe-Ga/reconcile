/**
 * Ask what to focus on (`#/g/{groupId}/priority`; #107; ADR-0074): one
 * question, a why, and 2–7 short options that everyone scores 0–4. The options
 * that pass rank by average, and the top one becomes the group's focus.
 *
 * The question starts as "What should we focus on?" and the form as two empty
 * options, with Add option up to seven and Remove down to two, then the
 * voting time in days within the class's bounds (`WindowField`, #106). Each option is
 * checked as it will be signed, NFC-normalized and trimmed, by the engine's
 * own rule (`optionProblems`), so the composer never sends what the fold would
 * ignore. Asking again after a lapse (#74) starts from the lapsed vote.
 */
import { type SyntheticEvent, useEffect, useRef, useState } from 'react';
import { Button, Form, Link } from 'react-aria-components';

import { messages } from '../app/messages';
import { optionText, type PriorityValues } from '../app/proposals';
import { routeHref } from '../app/router';
import { BackLink, Field, PageHeader } from '../app/ui';
import { holdPresses } from '../app/useSaving';
import { WindowField } from '../app/WindowField';
import { can } from '../engine/capabilities';
import { type GroupState, type Proposal, TITLE_MAX, WHY_MAX } from '../engine/fold';
import {
  OPTION_MAX,
  type OptionProblem,
  optionProblems,
  OPTIONS_MAX,
  OPTIONS_MIN,
  openPriority,
} from '../engine/priority';
import { type ProposalClass, targetClass, validWindow } from '../engine/rules';
import { nfcLength } from '../engine/text';
import type { ComposeOutcome } from './Composer';

/** Props for {@link PriorityComposer}. */
export interface PriorityComposerProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** The device clock now, in ms, which the voting time's closing line counts from. */
  readonly now: number;
  /** Queues the priority vote from valid entries. */
  readonly onAsk: (values: PriorityValues) => Promise<ComposeOutcome>;
  /** A lapsed priority vote to ask again (#74), from the `again` route. */
  readonly again?: Proposal;
  /** True once this device has left the group and waits for the relay to have its `leave` (#77). */
  readonly leaving?: boolean;
}

/** One option row: a key that stays with it as rows come and go, and its text as typed. */
interface Row {
  readonly key: number;
  readonly text: string;
}

const PROBLEMS: Readonly<Record<OptionProblem, string>> = {
  blank: messages.priority.optionBlank,
  'too-long': messages.priority.optionTooLong(OPTION_MAX),
  repeated: messages.priority.optionRepeated,
};

/** A required entry of at most `max` code points after NFC, trimmed. */
function required(missing: string, max: number, tooLong: string) {
  return (value: string): string | null => {
    const text = value.trim();
    if (text === '') return missing;
    return nfcLength(text) > max ? tooLong : null;
  };
}

const checkQuestion = required(
  messages.priority.questionMissing,
  TITLE_MAX,
  messages.priority.questionTooLong(TITLE_MAX),
);
const checkWhy = required(
  messages.priority.whyMissing,
  WHY_MAX,
  messages.composer.whyTooLong(WHY_MAX),
);

/** The class `targetClass` gives a priority vote, which bounds its voting time (#106). */
function priorityClass(state: GroupState): ProposalClass {
  return targetClass(state, { target: { kind: 'priority' }, title: '', why: '', options: [] });
}

/**
 * Where the form starts: the default question, two empty options and the
 * class's default voting time, or a lapsed vote's own.
 */
function startOf(state: GroupState, again: Proposal | undefined) {
  const texts = again === undefined ? ['', ''] : again.versions.map((option) => option.text);
  return {
    title: again?.title ?? messages.priority.question,
    why: again?.why ?? '',
    rows: texts.map((text, key) => ({ key, text })),
    window: again?.window ?? state.rules.windows[priorityClass(state)].default,
  };
}

/** Each row's problem as its option would be signed, or null for one that's fine. */
function problemsOf(rows: readonly Row[]): (OptionProblem | null)[] {
  return optionProblems(rows.map((row) => optionText(row.text)));
}

/** Runs `ask` once at a time; a queued vote leaves this screen, so it stays busy after one. */
function useAsk(ask: PriorityComposerProps['onAsk']) {
  const busy = useRef(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async (values: PriorityValues) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setFailed(false);
    const outcome = await ask(values).catch(() => 'failed' as const);
    if (outcome === 'proposed') return;
    busy.current = false;
    setRunning(false);
    setFailed(true);
  };
  return { run, running, failed };
}

interface OptionRowsProps {
  readonly rows: readonly Row[];
  readonly onChange: (rows: Row[]) => void;
  readonly onRemoved: (index: number) => void;
}

/** The option rows, each a field with Remove while more than two remain. */
function OptionRows({ rows, onChange, onRemoved }: OptionRowsProps) {
  const problems = problemsOf(rows);
  const { priority } = messages;
  return rows.map((row, index) => {
    const problem = problems[index] ?? null;
    return (
      <div key={row.key} className="option-row">
        <Field
          name={`option-${String(index + 1)}`}
          label={priority.optionLabel(index + 1)}
          autoComplete="off"
          isRequired
          validate={() => (problem === null ? null : PROBLEMS[problem])}
          value={row.text}
          onChange={(text) => {
            onChange(rows.map((other) => (other.key === row.key ? { ...row, text } : other)));
          }}
        />
        {rows.length > OPTIONS_MIN ? (
          <Button
            className="button button-quiet option-remove"
            aria-label={priority.removeLabel(index + 1)}
            onPress={() => {
              onChange(rows.filter((other) => other.key !== row.key));
              onRemoved(index);
            }}
          >
            {priority.remove}
          </Button>
        ) : null}
      </div>
    );
  });
}

interface FormProps {
  readonly state: GroupState;
  readonly now: number;
  readonly onAsk: PriorityComposerProps['onAsk'];
  readonly again: Proposal | undefined;
}

/** The question, why, options and voting time, then Ask your group. */
function PriorityForm({ state, now, onAsk, again }: FormProps) {
  const start = startOf(state, again);
  const cls = priorityClass(state);
  const [title, setTitle] = useState(start.title);
  const [why, setWhy] = useState(start.why);
  const [rows, setRows] = useState<Row[]>(start.rows);
  const [window, setWindow] = useState(start.window);
  const nextKey = useRef(start.rows.length);
  // A fresh object each time, so moving the focus to the same row again still runs the effect.
  const [focusRow, setFocusRow] = useState<{ readonly row: number } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const { run, running, failed } = useAsk(onAsk);
  const { priority } = messages;

  // After Add option, or Remove, the focus moves to the new row, or the row before the removed one.
  useEffect(() => {
    if (focusRow === null) return;
    const named = `input[name="option-${String(focusRow.row + 1)}"]`;
    form.current?.querySelector<HTMLInputElement>(named)?.focus();
  }, [focusRow]);

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (problemsOf(rows).some((problem) => problem !== null)) return;
    if (!validWindow(state.rules, cls, window)) return;
    const options = rows.map((row) => row.text);
    void run({ title: title.trim(), why: why.trim(), options, window });
  };
  const add = () => {
    setRows([...rows, { key: nextKey.current, text: '' }]);
    nextKey.current += 1;
    setFocusRow({ row: rows.length });
  };
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader
        title={again === undefined ? priority.title : messages.composer.againTitle}
        pageTitle={priority.pageTitle}
      />
      <p className="lede">{again === undefined ? priority.lede : messages.composer.againLede}</p>
      <Form ref={form} className="form" onSubmit={submit}>
        <Field
          name="title"
          label={priority.questionLabel}
          autoComplete="off"
          isRequired
          validate={checkQuestion}
          value={title}
          onChange={setTitle}
        />
        <Field
          name="why"
          label={messages.composer.whyLabel}
          hint={priority.whyHint}
          multiline
          isRequired
          validate={checkWhy}
          value={why}
          onChange={setWhy}
        />
        <fieldset className="options-field">
          <legend className="field-label">{priority.optionsLabel}</legend>
          <p className="field-hint">{priority.optionsHint(OPTIONS_MIN, OPTIONS_MAX, OPTION_MAX)}</p>
          <OptionRows
            rows={rows}
            onChange={setRows}
            onRemoved={(index) => {
              setFocusRow({ row: Math.max(0, index - 1) });
            }}
          />
          {rows.length < OPTIONS_MAX ? (
            <div>
              <Button className="button button-secondary" onPress={add}>
                {priority.addOption}
              </Button>
            </div>
          ) : null}
        </fieldset>
        <WindowField rules={state.rules} cls={cls} value={window} onChange={setWindow} now={now} />
        <p className="caption">{priority.visibility}</p>
        {failed ? (
          <p role="alert" className="form-error">
            {priority.failed}
          </p>
        ) : null}
        <div className="row form-actions" onPointerDownCapture={holdPresses(running)}>
          <Button type="submit" className="button button-primary" isDisabled={running}>
            {priority.submit}
          </Button>
        </div>
      </Form>
    </main>
  );
}

/** Why there's no form to show: the title and line to show instead, and the open vote to link to. */
interface NoForm {
  readonly title: string;
  readonly text: string;
  readonly open?: Proposal;
}

/** Why this member can't ask now, or null when they can: leaving, no `propose`, or a vote open. */
function noFormFor(state: GroupState, me: string, leaving: boolean): NoForm | null {
  const { priority, composer, leave } = messages;
  if (leaving) return { title: leave.noProposingTitle, text: leave.noProposing };
  if (!can(state, me, 'propose'))
    return { title: composer.notAllowedTitle, text: composer.notAllowed };
  const open = openPriority(state);
  return open === undefined ? null : { title: priority.openTitle, text: priority.open, open };
}

/** Shown in place of the form, with a link to the open vote when that's the reason. */
function Unavailable({ state, reason }: { readonly state: GroupState; reason: NoForm }) {
  const groupId = state.group ?? '';
  const { open } = reason;
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId }} label={state.name} />
      <PageHeader title={reason.title} pageTitle={messages.priority.pageTitle} />
      <p className="lede">{reason.text}</p>
      {open === undefined ? null : (
        <div>
          <Link
            className="button button-secondary"
            href={routeHref({ name: 'proposal', groupId, proposalId: open.id })}
          >
            {messages.priority.seeOpen}
          </Link>
        </div>
      )}
    </main>
  );
}

/**
 * The priority composer: the form for someone who may propose, isn't leaving
 * (#77), and finds no other priority vote open, else why not. Asking again
 * after a lapse starts from the lapsed vote's question, why, options and window.
 */
export function PriorityComposer(props: PriorityComposerProps) {
  const { state, me, now, onAsk, again } = props;
  const reason = noFormFor(state, me, props.leaving === true);
  if (reason !== null) return <Unavailable state={state} reason={reason} />;
  const lapsed = again?.final === true && again.outcome.kind === 'lapse' ? again : undefined;
  return (
    <PriorityForm key={lapsed?.id ?? 'new'} state={state} now={now} onAsk={onAsk} again={lapsed} />
  );
}
