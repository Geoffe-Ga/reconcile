import { type SyntheticEvent, useId, useRef, useState } from 'react';
import { Button, Form } from 'react-aria-components';

import { latestLink } from '../app/latestLink';
import { isHttpLink } from '../app/links';
import { messages } from '../app/messages';
import type { ProposalValues } from '../app/proposals';
import { BackLink, Field, PageHeader } from '../app/ui';
import { can } from '../engine/capabilities';
import { type Atom, type GroupState, TITLE_MAX, WHY_MAX } from '../engine/fold';
import { nfcLength } from '../engine/text';

/** How proposing went: `proposed` moves on to the Proposal; the others stay on the form. */
export type ComposeOutcome = 'proposed' | 'too-large' | 'failed';

/** Props for {@link Composer}. */
export interface ComposerProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** The Atom the Proposal would change, from the route. */
  readonly atomId: string;
  /** Queues the Proposal from valid entries. */
  readonly onPropose: (values: ProposalValues) => Promise<ComposeOutcome>;
}

/** Limits count code points after NFC (spec §4), never UTF-16 units as `maxLength` does. */
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

const checkText = (value: string) => (value.trim() === '' ? messages.composer.textMissing : null);

function checkLink(value: string): string | null {
  const link = value.trim();
  return link === '' || isHttpLink(link) ? null : messages.composer.linkInvalid;
}

function readValues(form: HTMLFormElement, atom: string): ProposalValues {
  const data = new FormData(form);
  const read = (name: string): string => {
    const value = data.get(name);
    return typeof value === 'string' ? value : '';
  };
  const link = read('link').trim();
  return {
    atom,
    title: read('title').trim(),
    why: read('why').trim(),
    text: read('text'),
    link: link === '' ? null : link,
  };
}

/** Shown in place of the form when there's nothing here to propose on. */
function Unavailable({ state, title, text }: { state: GroupState; title: string; text: string }) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'document', groupId: state.group ?? '' }} label={state.title} />
      <PageHeader title={title} pageTitle={messages.composer.pageTitle} />
      <p className="lede">{text}</p>
    </main>
  );
}

/** The section as it reads now, beside which the new text is written. */
function CurrentText({ atom, section }: { readonly atom: Atom; readonly section: number }) {
  const heading = useId();
  return (
    <section className="text-block" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {messages.composer.current(section)}
      </h2>
      <p className="atom-text atom-card atom-card-current" dir="auto">
        {atom.text}
      </p>
    </section>
  );
}

/** Runs `onPropose` once at a time, keeping the button disabled until it is done. */
function usePropose(onPropose: ComposerProps['onPropose']) {
  const busy = useRef(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const run = async (values: ProposalValues) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setFailed(false);
    // Each submit starts with no refusals, so `refused` only holds the latest answer.
    setRefused({});
    const outcome = await onPropose(values).catch(() => 'failed' as const);
    // A Proposal that was queued leaves this screen, so the button stays disabled.
    if (outcome === 'proposed') return;
    busy.current = false;
    setRunning(false);
    setRefused(outcome === 'too-large' ? { text: messages.composer.tooLarge } : {});
    setFailed(outcome === 'failed');
  };
  return { run, running, failed, refused };
}

interface ComposerFormProps {
  readonly state: GroupState;
  readonly atom: Atom;
  readonly section: number;
  readonly onPropose: ComposerProps['onPropose'];
}

function ComposerForm({ state, atom, section, onPropose }: ComposerFormProps) {
  const { run, running, failed, refused } = usePropose(onPropose);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(readValues(event.currentTarget, atom.id));
  };
  return (
    <main className="shell">
      <BackLink to={{ name: 'document', groupId: state.group ?? '' }} label={state.title} />
      <PageHeader title={messages.composer.title} pageTitle={messages.composer.pageTitle} />
      <CurrentText atom={atom} section={section} />
      <Form className="form" onSubmit={submit} validationErrors={refused}>
        <Field
          name="title"
          label={messages.composer.titleLabel}
          hint={messages.composer.titleHint}
          autoComplete="off"
          isRequired
          validate={checkTitle}
        />
        <Field
          name="why"
          label={messages.composer.whyLabel}
          hint={messages.composer.whyHint}
          multiline
          isRequired
          validate={checkWhy}
        />
        <Field
          name="text"
          label={messages.composer.textLabel}
          hint={messages.composer.textHint}
          multiline
          inputClassName="input-document"
          defaultValue={atom.text}
          isRequired
          validate={checkText}
        />
        <Field
          name="link"
          label={messages.composer.linkLabel}
          hint={messages.composer.linkHint}
          inputMode="url"
          autoComplete="off"
          defaultValue={latestLink(state) ?? ''}
          validate={checkLink}
        />
        <p className="caption">{messages.composer.visibility}</p>
        {failed ? (
          <p role="alert" className="form-error">
            {messages.composer.failed}
          </p>
        ) : null}
        <Button type="submit" className="button button-primary" isDisabled={running}>
          {messages.composer.submit}
        </Button>
      </Form>
    </main>
  );
}

/**
 * The composer (`#/g/{groupId}/propose/{atomId}`; spec §8): a title, a why,
 * the section's new text (prefilled with the current text) and a discussion
 * link (prefilled with the group's latest one). Submitting queues one
 * `proposal`. Only someone who may propose sees the form (`can()`).
 */
export function Composer({ state, me, atomId, onPropose }: ComposerProps) {
  const index = state.atoms.findIndex((candidate) => candidate.id === atomId);
  const atom = state.atoms[index];
  if (atom === undefined) {
    const { missingTitle, missing } = messages.composer;
    return <Unavailable state={state} title={missingTitle} text={missing} />;
  }
  if (!can(state, me, 'propose')) {
    const { notAllowedTitle, notAllowed } = messages.composer;
    return <Unavailable state={state} title={notAllowedTitle} text={notAllowed} />;
  }
  return <ComposerForm state={state} atom={atom} section={index + 1} onPropose={onPropose} />;
}
