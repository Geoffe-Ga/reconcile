/**
 * Ask what to focus on (`#/g/{groupId}/priority`; #107; ADR-0074): one
 * question, a why, and 2–7 short options that everyone scores 0–4. The options
 * that pass rank by average, and the top one becomes the group's focus.
 *
 * The question starts as "What should we focus on?" and the form as two empty
 * options, with Add option up to seven and Remove down to two. Each option is
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
import { nfcLength } from '../engine/text';
import type { ComposeOutcome } from './Composer';

/** Props for {@link PriorityComposer}. */
export interface PriorityComposerProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** Queues the priority vote from valid entries. */
  readonly onAsk: (values: PriorityValues) => Promise<ComposeOutcome>;
  /** A lapsed priority vote to ask again (#74), from the `again` route. */
  readonly again?: Proposal;
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

/** Where the form starts: the default question and two empty options, or a lapsed vote's own. */
function startOf(again: Proposal | undefined) {
  const texts = again === undefined ? ['', ''] : again.versions.map((option) => option.text);
  return {
    title: again?.title ?? messages.priority.question,
    why: again?.why ?? '',
    rows: texts.map((text, key) => ({ key, text })),
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
  readonly onAsk: PriorityComposerProps['onAsk'];
  readonly again: Proposal | undefined;
}

/** The question, why and options, then Ask your group. */
function PriorityForm({ state, onAsk, again }: FormProps) {
  const start = startOf(again);
  const [title, setTitle] = useState(start.title);
  const [why, setWhy] = useState(start.why);
  const [rows, setRows] = useState<Row[]>(start.rows);
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
    void run({ title: title.trim(), why: why.trim(), options: rows.map((row) => row.text) });
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

/** Shown in place of the form when this member can't ask, or a priority vote is open. */
function Unavailable({ state, open }: { readonly state: GroupState; open: Proposal | undefined }) {
  const groupId = state.group ?? '';
  const { priority, composer } = messages;
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId }} label={state.name} />
      <PageHeader
        title={open === undefined ? composer.notAllowedTitle : priority.openTitle}
        pageTitle={priority.pageTitle}
      />
      <p className="lede">{open === undefined ? composer.notAllowed : priority.open}</p>
      {open === undefined ? null : (
        <div>
          <Link
            className="button button-secondary"
            href={routeHref({ name: 'proposal', groupId, proposalId: open.id })}
          >
            {priority.seeOpen}
          </Link>
        </div>
      )}
    </main>
  );
}

/**
 * The priority composer: the form for someone who may propose while no other
 * priority vote is open, else why not. Asking again after a lapse starts from
 * the lapsed vote's question, why and options.
 */
export function PriorityComposer({ state, me, onAsk, again }: PriorityComposerProps) {
  const open = openPriority(state);
  if (!can(state, me, 'propose') || open !== undefined) {
    return <Unavailable state={state} open={can(state, me, 'propose') ? open : undefined} />;
  }
  const lapsed = again?.final === true && again.outcome.kind === 'lapse' ? again : undefined;
  return <PriorityForm key={lapsed?.id ?? 'new'} state={state} onAsk={onAsk} again={lapsed} />;
}
