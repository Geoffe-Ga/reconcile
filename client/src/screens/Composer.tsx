import { type ReactNode, type SyntheticEvent, useId, useRef, useState } from 'react';
import { Button, CheckboxButton, CheckboxField, Form, Text } from 'react-aria-components';

import { latestLink } from '../app/latestLink';
import { isHttpLink } from '../app/links';
import { messages } from '../app/messages';
import { checkDispatchText, checkDispatchTitle } from '../app/proposalFields';
import { againDraft, type ProposalValues, type VersionValues } from '../app/proposals';
import { suspendedLine } from '../app/stewardLines';
import { AtomText } from '../app/text/AtomText';
import { MarkdownField } from '../app/text/MarkdownField';
import { BackLink, Field, PageHeader } from '../app/ui';
import { type DraftState, useDraft } from '../app/useDraft';
import { WindowField } from '../app/WindowField';
import { normalizeAtomText } from '../engine/atomText';
import { can } from '../engine/capabilities';
import { composeOption, openProposalOn } from '../engine/composeOption';
import { type Atom, type GroupState, type Proposal, TITLE_MAX, WHY_MAX } from '../engine/fold';
import { type ProposalClass, targetClass } from '../engine/rules';
import { nfcLength } from '../engine/text';
import type { Draft, DraftDispatch, GroupDrafts } from '../store/drafts';

/** How sending went: `proposed` and `added` move on to the Proposal; the others stay on the form. */
export type ComposeOutcome = 'proposed' | 'added' | 'too-large' | 'failed';

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
  /** The device clock now, in ms, which the voting time's closing line counts from. */
  readonly now: number;
  /** Queues the Proposal from valid entries, clearing its draft as it does. */
  readonly onPropose: (values: ProposalValues) => Promise<ComposeOutcome>;
  /** Queues a version of the section's open Proposal, clearing its draft as it does. */
  readonly onAddVersion: (values: VersionValues) => Promise<ComposeOutcome>;
  /** A lapsed Proposal to propose again on this section (#74), from the `again` route. */
  readonly again?: Proposal;
  /** Whether this device's leave waits for the relay (#77): then it shows no form. */
  readonly leaving?: boolean;
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
function textCheck(current: string, missing: string = messages.composer.textMissing) {
  const now = normalizeAtomText(current);
  return (value: string): string | null => {
    const text = normalizeAtomText(value);
    if (text === '') return missing;
    return text === now ? messages.composer.textUnchanged : null;
  };
}

/** As {@link textCheck}, and refuses text that normalizes to a version already on the ballot. */
function versionCheck(current: string, proposal: Proposal) {
  const section = textCheck(current, messages.composer.versionMissing);
  const onBallot = new Set(proposal.versions.map((version) => normalizeAtomText(version.text)));
  return (value: string): string | null =>
    section(value) ??
    (onBallot.has(normalizeAtomText(value)) ? messages.composer.textOnBallot : null);
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

/**
 * The entries as the Proposal takes them: title, why and link trimmed, a
 * blank link none, and any Dispatch's title and text trimmed (#112).
 */
function toValues(draft: Draft, atom: string, window: number): ProposalValues {
  const link = draft.link.trim();
  const { dispatch } = draft;
  return {
    atom,
    title: draft.title.trim(),
    why: draft.why.trim(),
    text: draft.text,
    link: link === '' ? null : link,
    window,
    ...(dispatch === undefined
      ? {}
      : { dispatch: { title: dispatch.title.trim(), text: dispatch.text.trim() } }),
  };
}

/** `draft` with no Dispatch (#112): "Send a Dispatch if this passes" unchecked. */
function withoutDispatch({ title, why, text, link, window }: Draft): Draft {
  return { title, why, text, link, ...(window === undefined ? {} : { window }) };
}

/** The class `targetClass` gives this Proposal as it stands, which bounds its voting time. */
function classOf(state: GroupState, draft: Draft, atom: string): ProposalClass {
  return targetClass(state, { atom, title: draft.title, why: draft.why, text: draft.text });
}

/** The voting time to show and send: the draft's, or else its class's default. */
function windowOf(state: GroupState, draft: Draft, atom: string): number {
  return draft.window ?? state.rules.windows[classOf(state, draft, atom)].default;
}

/** Where a new composer starts: a blank title and why, the section's text, the latest link. */
function startOf(state: GroupState, atom: Atom): Draft {
  return { title: '', why: '', text: atom.text, link: latestLink(state) ?? '' };
}

/**
 * Where proposing again starts: the lapsed Proposal's title, why, text, link
 * and voting time, and the Dispatch it carried, if any (#112).
 */
function againStartOf(state: GroupState, again: Proposal): Draft {
  return {
    title: again.title,
    why: again.why,
    text: again.text,
    link: again.link ?? latestLink(state) ?? '',
    window: again.window,
    ...(again.dispatch === null ? {} : { dispatch: again.dispatch }),
  };
}

/** The entries as the Proposal takes them, and, proposing again, the other versions' texts too. */
function valuesOf(
  draft: Draft,
  atom: string,
  again: Proposal | undefined,
  window: number,
): ProposalValues {
  const values = toValues(draft, atom, window);
  if (again === undefined) return values;
  return { ...values, again: again.id, versions: again.versions.slice(1).map((v) => v.text) };
}

/** True for a Proposal whose vote lapsed, which Propose again repeats (ADR-0069). */
function hasLapsed(proposal: Proposal): boolean {
  return proposal.final && proposal.outcome.kind === 'lapse';
}

/** Where a new version starts: the section's text. A version keeps only its text. */
function versionStartOf(atom: Atom): Draft {
  return { title: '', why: '', text: atom.text, link: '' };
}

interface UnavailableProps {
  readonly state: GroupState;
  readonly title: string;
  readonly text: string;
}

/** Shown in place of the form when there's nothing here to propose on. */
function Unavailable({ state, title, text }: UnavailableProps) {
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
 * Runs `send` once at a time, keeping the button disabled until it is done.
 * The draft holds still while the Proposal or version is queued, since
 * queuing clears it, and saves again if it couldn't be queued.
 */
function useSend<V>(send: (values: V) => Promise<ComposeOutcome>, draft: DraftState) {
  const busy = useRef(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const run = async (values: V) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setFailed(false);
    // Each submit starts with no refusals, so `refused` only holds the latest answer.
    setRefused({});
    draft.hold();
    const outcome = await send(values).catch(() => 'failed' as const);
    // What was queued leaves this screen, so the button stays disabled.
    if (outcome === 'proposed' || outcome === 'added') return;
    draft.resume();
    busy.current = false;
    setRunning(false);
    setRefused(outcome === 'too-large' ? { text: messages.composer.tooLarge } : {});
    setFailed(outcome === 'failed');
  };
  return { run, running, failed, refused };
}

interface DispatchFieldsProps {
  readonly dispatch: DraftDispatch;
  readonly onChange: (dispatch: DraftDispatch) => void;
}

/** The Dispatch's title and text, under the checkbox, checked as a sent Dispatch's are (#112). */
function DispatchFields({ dispatch, onChange }: DispatchFieldsProps) {
  const { composer } = messages;
  return (
    <>
      <Field
        name="dispatchTitle"
        label={composer.dispatchTitleLabel}
        autoComplete="off"
        isRequired
        validate={checkDispatchTitle}
        value={dispatch.title}
        onChange={(title) => {
          onChange({ ...dispatch, title });
        }}
      />
      <Field
        name="dispatchText"
        label={composer.dispatchTextLabel}
        multiline
        validate={checkDispatchText}
        value={dispatch.text}
        onChange={(text) => {
          onChange({ ...dispatch, text });
        }}
      />
    </>
  );
}

interface DispatchChoiceProps {
  readonly state: GroupState;
  readonly values: Draft;
  readonly onChange: (values: Draft) => void;
}

/**
 * "Send a Dispatch if this passes" (#112), a React Aria checkbox, unchecked
 * to start. Checked, it opens the Dispatch's title, which starts as
 * 'Updated: {Document title}', and its text, both kept in the draft.
 */
function DispatchChoice({ state, values, onChange }: DispatchChoiceProps) {
  const { composer } = messages;
  const { dispatch } = values;
  const toggle = (on: boolean) => {
    const opened = { title: composer.dispatchTitle(state.title), text: '' };
    onChange(on ? { ...values, dispatch: opened } : withoutDispatch(values));
  };
  return (
    <div className="stack dispatch-choice">
      <CheckboxField
        className="check-option"
        name="dispatch"
        isSelected={dispatch !== undefined}
        onChange={toggle}
      >
        <CheckboxButton className="checkbox">
          <span className="checkbox-box" aria-hidden="true" />
          {composer.dispatchLabel}
        </CheckboxButton>
        <Text slot="description" className="check-description">
          {composer.dispatchHint}
        </Text>
      </CheckboxField>
      {dispatch === undefined ? null : (
        <DispatchFields
          dispatch={dispatch}
          onChange={(next) => {
            onChange({ ...values, dispatch: next });
          }}
        />
      )}
    </div>
  );
}

interface FieldsProps {
  readonly state: GroupState;
  readonly values: Draft;
  readonly atom: Atom;
  readonly now: number;
  readonly onChange: (values: Draft) => void;
}

/**
 * The four entries, the voting time and any Dispatch it carries (#112), each
 * kept in the draft as it changes.
 */
function Fields({ state, values, atom, now, onChange }: FieldsProps) {
  const set = (key: 'title' | 'why' | 'text' | 'link') => (value: string) => {
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
      <WindowField
        rules={state.rules}
        cls={classOf(state, values, atom.id)}
        value={windowOf(state, values, atom.id)}
        onChange={(window) => {
          onChange({ ...values, window });
        }}
        now={now}
      />
      <DispatchChoice state={state} values={values} onChange={onChange} />
    </>
  );
}

/** One of the lapsed Proposal's other versions, as it will go on the new ballot. */
function OtherVersion({ number, text }: { readonly number: number; readonly text: string }) {
  const heading = useId();
  return (
    <section className="text-block" aria-labelledby={heading}>
      <h3 id={heading} className="version-heading">
        {messages.ballot.version(number)}
      </h3>
      <AtomText text={text} className="atom-card" />
    </section>
  );
}

/** "Also on the ballot": the versions after the first, which proposing again carries over. */
function OtherVersions({ again }: { readonly again: Proposal | undefined }) {
  const heading = useId();
  const others = again?.versions.slice(1) ?? [];
  if (others.length === 0) return null;
  return (
    <section className="text-block" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {messages.composer.againVersions}
      </h2>
      <p className="caption">{messages.composer.againVersionsHint}</p>
      {others.map((version, index) => (
        <OtherVersion key={version.id} number={index + 2} text={version.text} />
      ))}
    </section>
  );
}

interface ComposerFormProps {
  readonly state: GroupState;
  readonly atom: Atom;
  readonly section: number;
  readonly drafts: GroupDrafts;
  readonly now: number;
  readonly onPropose: ComposerProps['onPropose'];
  /** The lapsed Proposal this proposes again, or undefined for a new one. */
  readonly again: Proposal | undefined;
}

function ComposerForm({ state, atom, section, drafts, now, onPropose, again }: ComposerFormProps) {
  const target = again === undefined ? atom.id : againDraft(again.id);
  const start = again === undefined ? startOf(state, atom) : againStartOf(state, again);
  const draft = useDraft(drafts, target, start);
  const { run, running, failed, refused } = useSend(onPropose, draft);
  const form = useRef<HTMLFormElement>(null);
  const [said, setSaid] = useState('');
  const { values } = draft;
  // The draft is read before the form shows, so nothing typed is ever replaced by it.
  if (values === null) return null;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(valuesOf(values, atom.id, again, windowOf(state, values, atom.id)));
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
      <PageHeader
        title={again === undefined ? messages.composer.title : messages.composer.againTitle}
        pageTitle={messages.composer.pageTitle}
      />
      {again === undefined ? null : <p className="lede">{messages.composer.againLede}</p>}
      <CurrentText atom={atom} section={section} />
      {draft.restored ? <p className="draft-note">{messages.composer.draftRestored}</p> : null}
      <Form ref={form} className="form" onSubmit={submit} validationErrors={refused}>
        <Fields state={state} values={values} atom={atom} now={now} onChange={change} />
        <OtherVersions again={again} />
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

interface VersionFormProps {
  readonly state: GroupState;
  readonly atom: Atom;
  readonly section: number;
  readonly proposal: Proposal;
  readonly drafts: GroupDrafts;
  readonly onAddVersion: ComposerProps['onAddVersion'];
}

/**
 * "Add your version" (ADR-0004): the new text alone, for the section's open
 * Proposal, starting from the section as it reads now. Its draft is kept
 * under the Proposal, apart from any Proposal drafted for the section.
 */
function VersionForm({ state, atom, section, proposal, drafts, onAddVersion }: VersionFormProps) {
  const draft = useDraft(drafts, proposal.id, versionStartOf(atom));
  const { run, running, failed, refused } = useSend(onAddVersion, draft);
  const form = useRef<HTMLFormElement>(null);
  const [said, setSaid] = useState('');
  const { values } = draft;
  // The draft is read before the form shows, so nothing typed is ever replaced by it.
  if (values === null) return null;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run({ proposal: proposal.id, text: values.text });
  };
  const discard = () => {
    draft.discard();
    setSaid(messages.composer.discarded);
    form.current?.querySelector<HTMLTextAreaElement>('textarea[name="text"]')?.focus();
  };
  const groupId = state.group ?? '';
  return (
    <main className="shell">
      <BackLink
        to={{ name: 'proposal', groupId, proposalId: proposal.id }}
        label={proposal.title}
      />
      <PageHeader
        title={messages.composer.versionTitle}
        pageTitle={messages.composer.versionPageTitle}
      />
      <p className="lede">{messages.composer.versionLede}</p>
      <CurrentText atom={atom} section={section} />
      {draft.restored ? <p className="draft-note">{messages.composer.draftRestored}</p> : null}
      <Form ref={form} className="form" onSubmit={submit} validationErrors={refused}>
        <MarkdownField
          name="text"
          label={messages.composer.versionLabel}
          hint={messages.composer.versionHint}
          value={values.text}
          onChange={(text) => {
            setSaid('');
            draft.update({ ...values, text });
          }}
          validate={versionCheck(atom.text, proposal)}
          isRequired
          preview={preview}
        />
        <p className="caption">{messages.composer.versionVisibility}</p>
        {failed ? (
          <p role="alert" className="form-error">
            {messages.composer.versionFailed}
          </p>
        ) : null}
        <div className="row form-actions">
          <Button type="submit" className="button button-primary" isDisabled={running}>
            {messages.composer.versionSubmit}
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
 * Why this member gets no form, or null when they get one: their leave waits
 * for the relay (#77), or they may not propose, and a suspended member reads
 * until when rather than that their level can't propose (#102).
 */
function whyNoForm(props: ComposerProps): { readonly title: string; readonly text: string } | null {
  const { state, me } = props;
  const { composer, leave } = messages;
  if (props.leaving === true) return { title: leave.noProposingTitle, text: leave.noProposing };
  if (can(state, me, 'propose')) return null;
  return { title: composer.notAllowedTitle, text: suspendedLine(state, me) ?? composer.notAllowed };
}

/**
 * The composer (`#/g/{groupId}/propose/{atomId}`; spec §8). On a section with
 * no open Proposal: a title, a why, the section's new text in Write and
 * Preview tabs (prefilled with the current text), a discussion link
 * (prefilled with the group's latest one), the voting time in days (the
 * class default, within its bounds; #106), and "Send a Dispatch if this
 * passes" (#112), and submitting queues one `proposal`. On a section whose Proposal is open, "Add your version": the
 * text alone, and submitting queues one `version`. A full ballot takes no
 * more. `composeOption` decides which, as it does for the fold. What is typed
 * is kept as a private draft on this device until it is sent or discarded.
 * Only someone who may propose, and isn't leaving, sees a form (`can()`).
 *
 * Proposing a lapsed Proposal again (#74) is the same form, starting from its
 * title, why, text and link, with its other versions carried onto the new
 * ballot. Its draft is kept under that Proposal, apart from the section's.
 */
export function Composer(props: ComposerProps) {
  const { state, atomId, drafts } = props;
  const index = state.atoms.findIndex((candidate) => candidate.id === atomId);
  const atom = state.atoms[index];
  const { composer } = messages;
  if (atom === undefined) {
    return <Unavailable state={state} title={composer.missingTitle} text={composer.missing} />;
  }
  const refused = whyNoForm(props);
  if (refused !== null) return <Unavailable state={state} {...refused} />;
  const open = openProposalOn(state, atom.id);
  const option = composeOption(state, atom.id);
  if (option === 'ballot-full') {
    return <Unavailable state={state} title={composer.fullTitle} text={composer.full} />;
  }
  if (open !== undefined) {
    return (
      <VersionForm
        key={open.id}
        state={state}
        atom={atom}
        section={index + 1}
        proposal={open}
        drafts={drafts}
        onAddVersion={props.onAddVersion}
      />
    );
  }
  const again = props.again !== undefined && hasLapsed(props.again) ? props.again : undefined;
  return (
    <ComposerForm
      key={again?.id ?? atom.id}
      state={state}
      atom={atom}
      section={index + 1}
      drafts={drafts}
      now={props.now}
      onPropose={props.onPropose}
      again={again}
    />
  );
}
