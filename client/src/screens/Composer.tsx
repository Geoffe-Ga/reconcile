import { type ReactNode, type SyntheticEvent, useId, useRef, useState } from 'react';
import { Button, Form } from 'react-aria-components';

import { latestLink } from '../app/latestLink';
import { isHttpLink } from '../app/links';
import { messages } from '../app/messages';
import type { ProposalValues } from '../app/proposals';
import { AtomText } from '../app/text/AtomText';
import { MarkdownField } from '../app/text/MarkdownField';
import { BackLink, Field, PageHeader } from '../app/ui';
import { type DraftState, useDraft } from '../app/useDraft';
import { normalizeAtomText } from '../engine/atomText';
import { can } from '../engine/capabilities';
import { type Atom, type GroupState, TITLE_MAX, WHY_MAX } from '../engine/fold';
import { nfcLength } from '../engine/text';
import type { Draft, GroupDrafts } from '../store/drafts';

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
  /** This group's private drafts on this device. */
  readonly drafts: GroupDrafts;
  /** Queues the Proposal from valid entries, clearing its draft as it does. */
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

/** Refuses blank text, and text that normalizes to the section's own (spec §4). */
function textCheck(current: string) {
  const now = normalizeAtomText(current);
  return (value: string): string | null => {
    const text = normalizeAtomText(value);
    if (text === '') return messages.composer.textMissing;
    return text === now ? messages.composer.textUnchanged : null;
  };
}

function checkLink(value: string): string | null {
  const link = value.trim();
  return link === '' || isHttpLink(link) ? null : messages.composer.linkInvalid;
}

/** The new text as it will read: normalized, as it will be signed, then rendered. */
function preview(value: string): ReactNode {
  const text = normalizeAtomText(value);
  return text === '' ? null : <AtomText text={text} />;
}

/** The entries as the Proposal takes them: title, why and link trimmed, a blank link none. */
function toValues(draft: Draft, atom: string): ProposalValues {
  const link = draft.link.trim();
  return {
    atom,
    title: draft.title.trim(),
    why: draft.why.trim(),
    text: draft.text,
    link: link === '' ? null : link,
  };
}

/** Where a new composer starts: a blank title and why, the section's text, the latest link. */
function startOf(state: GroupState, atom: Atom): Draft {
  return { title: '', why: '', text: atom.text, link: latestLink(state) ?? '' };
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
      <AtomText text={atom.text} className="atom-card atom-card-current" />
    </section>
  );
}

/**
 * Runs `onPropose` once at a time, keeping the button disabled until it is
 * done. The draft holds still while the Proposal is queued, since queuing
 * clears it, and saves again if the Proposal couldn't be queued.
 */
function usePropose(onPropose: ComposerProps['onPropose'], draft: DraftState) {
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
    draft.hold();
    const outcome = await onPropose(values).catch(() => 'failed' as const);
    // A Proposal that was queued leaves this screen, so the button stays disabled.
    if (outcome === 'proposed') return;
    draft.resume();
    busy.current = false;
    setRunning(false);
    setRefused(outcome === 'too-large' ? { text: messages.composer.tooLarge } : {});
    setFailed(outcome === 'failed');
  };
  return { run, running, failed, refused };
}

interface FieldsProps {
  readonly values: Draft;
  readonly atom: Atom;
  readonly onChange: (values: Draft) => void;
}

/** The four entries, each kept in the draft as it changes. */
function Fields({ values, atom, onChange }: FieldsProps) {
  const set = (key: keyof Draft) => (value: string) => {
    onChange({ ...values, [key]: value });
  };
  return (
    <>
      <Field
        name="title"
        label={messages.composer.titleLabel}
        hint={messages.composer.titleHint}
        autoComplete="off"
        isRequired
        validate={checkTitle}
        value={values.title}
        onChange={set('title')}
      />
      <Field
        name="why"
        label={messages.composer.whyLabel}
        hint={messages.composer.whyHint}
        multiline
        isRequired
        validate={checkWhy}
        value={values.why}
        onChange={set('why')}
      />
      <MarkdownField
        name="text"
        label={messages.composer.textLabel}
        hint={messages.composer.textHint}
        value={values.text}
        onChange={set('text')}
        validate={textCheck(atom.text)}
        isRequired
        preview={preview}
      />
      <Field
        name="link"
        label={messages.composer.linkLabel}
        hint={messages.composer.linkHint}
        inputMode="url"
        autoComplete="off"
        validate={checkLink}
        value={values.link}
        onChange={set('link')}
      />
    </>
  );
}

interface ComposerFormProps {
  readonly state: GroupState;
  readonly atom: Atom;
  readonly section: number;
  readonly drafts: GroupDrafts;
  readonly onPropose: ComposerProps['onPropose'];
}

function ComposerForm({ state, atom, section, drafts, onPropose }: ComposerFormProps) {
  const draft = useDraft(drafts, atom.id, startOf(state, atom));
  const { run, running, failed, refused } = usePropose(onPropose, draft);
  const form = useRef<HTMLFormElement>(null);
  const [said, setSaid] = useState('');
  const { values } = draft;
  // The draft is read before the form shows, so nothing typed is ever replaced by it.
  if (values === null) return null;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(toValues(values, atom.id));
  };
  const change = (next: Draft) => {
    setSaid('');
    draft.update(next);
  };
  const discard = () => {
    draft.discard();
    setSaid(messages.composer.discarded);
    form.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
  };
  return (
    <main className="shell">
      <BackLink to={{ name: 'document', groupId: state.group ?? '' }} label={state.title} />
      <PageHeader title={messages.composer.title} pageTitle={messages.composer.pageTitle} />
      <CurrentText atom={atom} section={section} />
      {draft.restored ? <p className="draft-note">{messages.composer.draftRestored}</p> : null}
      <Form ref={form} className="form" onSubmit={submit} validationErrors={refused}>
        <Fields values={values} atom={atom} onChange={change} />
        <p className="caption">{messages.composer.visibility}</p>
        {failed ? (
          <p role="alert" className="form-error">
            {messages.composer.failed}
          </p>
        ) : null}
        <div className="row form-actions">
          <Button type="submit" className="button button-primary" isDisabled={running}>
            {messages.composer.submit}
          </Button>
          {draft.changed ? (
            <Button className="button button-quiet" isDisabled={running} onPress={discard}>
              {messages.composer.discard}
            </Button>
          ) : null}
        </div>
        <p role="status" className="status">
          {said}
        </p>
      </Form>
    </main>
  );
}

/**
 * The composer (`#/g/{groupId}/propose/{atomId}`; spec §8): a title, a why,
 * the section's new text in Write and Preview tabs (prefilled with the current
 * text), and a discussion link (prefilled with the group's latest one). What
 * is typed is kept as a private draft on this device until it is proposed or
 * discarded. Submitting queues one `proposal`. Only someone who may propose
 * sees the form (`can()`).
 */
export function Composer({ state, me, atomId, drafts, onPropose }: ComposerProps) {
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
  return (
    <ComposerForm
      key={atom.id}
      state={state}
      atom={atom}
      section={index + 1}
      drafts={drafts}
      onPropose={onPropose}
    />
  );
}
