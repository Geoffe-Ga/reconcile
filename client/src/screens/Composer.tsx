import { type ReactNode, type SyntheticEvent, useId, useRef, useState } from 'react';
import { Button, Form } from 'react-aria-components';

import { againStartOf, type ComposeOutcome, lapsed, textCheck, useSend } from '../app/compose';
import { latestLink } from '../app/latestLink';
import { isHttpLink } from '../app/links';
import { messages } from '../app/messages';
import {
  againDraft,
  type ProposalPlace,
  type ProposalValues,
  type VersionValues,
} from '../app/proposals';
import { suspendedLine } from '../app/stewardLines';
import { AtomText } from '../app/text/AtomText';
import { MarkdownField } from '../app/text/MarkdownField';
import { BackLink, Field, PageHeader } from '../app/ui';
import { useDraft } from '../app/useDraft';
import { versionDoes } from '../app/versionViews';
import { normalizeAtomText } from '../engine/atomText';
import { can } from '../engine/capabilities';
import { composeOption, openProposalOn } from '../engine/composeOption';
import { type Atom, type GroupState, type Proposal, TITLE_MAX, WHY_MAX } from '../engine/fold';
import { nfcLength } from '../engine/text';
import type { Draft, GroupDrafts } from '../store/drafts';

export type { ComposeOutcome } from '../app/compose';

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
  /** Queues a version of the section's open Proposal, clearing its draft as it does. */
  readonly onAddVersion: (values: VersionValues) => Promise<ComposeOutcome>;
  /** A lapsed Proposal to propose again on this section (#74), from the `again` route. */
  readonly again?: Proposal;
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

/** As {@link textCheck}, and refuses text that normalizes to a version already on the ballot. */
function versionCheck(current: string, proposal: Proposal, missing: string) {
  const section = textCheck(current, missing);
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

/** The entries as the Proposal takes them: title, why and link trimmed, a blank link none. */
function toValues(draft: Draft, place: ProposalPlace): ProposalValues {
  const link = draft.link.trim();
  return {
    ...place,
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

/** The entries as the Proposal takes them, and, proposing again, the other versions' texts too. */
function valuesOf(draft: Draft, place: ProposalPlace, again: Proposal | undefined): ProposalValues {
  const values = toValues(draft, place);
  if (again === undefined) return values;
  return { ...values, again: again.id, versions: again.versions.slice(1).map((v) => v.text) };
}

/** Where a new version starts: the text it rewords. A version keeps only its text. */
function versionStartOf(text: string): Draft {
  return { title: '', why: '', text, link: '' };
}

interface UnavailableProps {
  readonly state: GroupState;
  readonly title: string;
  readonly text: string;
}

/** Shown in place of the form when there's nothing here to propose on. */
export function Unavailable({ state, title, text }: UnavailableProps) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'document', groupId: state.group ?? '' }} label={state.title} />
      <PageHeader title={title} pageTitle={messages.composer.pageTitle} />
      <p className="lede">{text}</p>
    </main>
  );
}

/** The section as it reads now, beside which the new text is written. */
export function CurrentText({ atom, section }: { readonly atom: Atom; readonly section: number }) {
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

/** The text field of a Proposal's form: its label, its hint and its check. */
export interface TextEntry {
  readonly label: string;
  readonly hint: string;
  readonly validate: (value: string) => string | null;
}

interface FieldsProps {
  readonly values: Draft;
  /** The text field, or null for a removal, whose text is `""` (#75). */
  readonly text: TextEntry | null;
  readonly onChange: (values: Draft) => void;
}

/** The four entries, or three for a removal, each kept in the draft as it changes. */
function Fields({ values, text, onChange }: FieldsProps) {
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
      {text === null ? null : (
        <MarkdownField
          name="text"
          label={text.label}
          hint={text.hint}
          value={values.text}
          onChange={set('text')}
          validate={text.validate}
          isRequired
          preview={preview}
        />
      )}
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

/** One of the lapsed Proposal's other versions, as it will go on the new ballot. */
function OtherVersion({ number, text }: { readonly number: number; readonly text: string }) {
  const heading = useId();
  return (
    <section className="text-block" aria-labelledby={heading}>
      <h3 id={heading} className="version-heading">
        {messages.ballot.version(number)}
      </h3>
      {text === '' ? (
        <p className="version-does">{messages.proposal.removes}</p>
      ) : (
        <AtomText text={text} className="atom-card" />
      )}
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

/** Proposing again (#74): the line that says this repeats a lapsed Proposal, or nothing. */
export function AgainLede({ again }: { readonly again: Proposal | undefined }) {
  return again === undefined ? null : <p className="lede">{messages.composer.againLede}</p>;
}

/** The words of a Proposal's form: its heading, the tab's title and its button. */
export interface FormWords {
  readonly title: string;
  readonly pageTitle: string;
  readonly submit: string;
}

/** Props for {@link ProposalForm}. */
export interface ProposalFormProps {
  readonly state: GroupState;
  /** Where the Proposal goes: an Atom, or a new section's spot. */
  readonly place: ProposalPlace;
  /** The key its private draft is kept under. */
  readonly draftKey: string;
  /** Where a new draft starts. */
  readonly start: Draft;
  readonly drafts: GroupDrafts;
  readonly onPropose: ComposerProps['onPropose'];
  readonly words: FormWords;
  /** What sits between the heading and the form, such as the section as it reads now. */
  readonly intro: ReactNode;
  /** The text field, or null for a removal. */
  readonly text: TextEntry | null;
  /** The lapsed Proposal this proposes again (#74), whose other versions it carries, or undefined. */
  readonly again: Proposal | undefined;
}

/**
 * A Proposal's form: a title, a why, the text (unless it removes a section)
 * and a discussion link, kept as a private draft until it is proposed, with
 * Discard draft once it has changed. Submitting queues one `proposal`, and
 * proposing again, one `version` for each of the lapsed Proposal's others.
 */
export function ProposalForm(props: ProposalFormProps) {
  const { state, place, drafts, onPropose, words } = props;
  const draft = useDraft(drafts, props.draftKey, props.start);
  const { run, running, failed, refused } = useSend(onPropose, draft);
  const form = useRef<HTMLFormElement>(null);
  const [said, setSaid] = useState('');
  const { values } = draft;
  // The draft is read before the form shows, so nothing typed is ever replaced by it.
  if (values === null) return null;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(valuesOf(values, place, props.again));
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
      <PageHeader title={words.title} pageTitle={words.pageTitle} />
      {props.intro}
      {draft.restored ? <p className="draft-note">{messages.composer.draftRestored}</p> : null}
      <Form ref={form} className="form" onSubmit={submit} validationErrors={refused}>
        <Fields values={values} text={props.text} onChange={change} />
        <OtherVersions again={props.again} />
        <p className="caption">{messages.composer.visibility}</p>
        {failed ? (
          <p role="alert" className="form-error">
            {messages.composer.failed}
          </p>
        ) : null}
        <div className="row form-actions">
          <Button type="submit" className="button button-primary" isDisabled={running}>
            {words.submit}
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

/** The section a version rewords, and its number. */
interface Section {
  readonly atom: Atom;
  readonly number: number;
}

interface VersionFormProps {
  readonly state: GroupState;
  /** The section the Proposal changes, or null when it adds one (#75). */
  readonly section: Section | null;
  readonly proposal: Proposal;
  readonly drafts: GroupDrafts;
  readonly onAddVersion: ComposerProps['onAddVersion'];
}

/** What sits above a version's text: the section as it reads now, or where an add's section goes. */
function VersionIntro({
  state,
  section,
  proposal,
}: Omit<VersionFormProps, 'drafts' | 'onAddVersion'>) {
  if (section !== null) {
    return (
      <>
        <p className="lede">{messages.composer.versionLede}</p>
        <CurrentText atom={section.atom} section={section.number} />
      </>
    );
  }
  return (
    <>
      <p className="lede">{messages.composer.addVersionLede}</p>
      <p className="version-does">{versionDoes(state, proposal.target, proposal.text)}</p>
    </>
  );
}

/**
 * What a version rewords and starts from, and its field's hint and blank
 * refusal: the section as it reads now, or for an add, nothing to reword and
 * the Proposal's own text to start from.
 */
function versionWords(section: Section | null, proposal: Proposal) {
  const { composer } = messages;
  if (section === null) {
    const add = { hint: composer.addVersionHint, missing: composer.addTextMissing };
    return { current: '', start: proposal.text, ...add };
  }
  const { text } = section.atom;
  return {
    current: text,
    start: text,
    hint: composer.versionHint,
    missing: composer.versionMissing,
  };
}

/**
 * "Add your version" (ADR-0004): the new text alone, for the section's open
 * Proposal, starting from the section as it reads now, or for an add (#75),
 * from the Proposal's own text. Its draft is kept under the Proposal, apart
 * from any Proposal drafted for the section.
 */
function VersionForm({ state, section, proposal, drafts, onAddVersion }: VersionFormProps) {
  const { current, start, hint, missing } = versionWords(section, proposal);
  const draft = useDraft(drafts, proposal.id, versionStartOf(start));
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
      <VersionIntro state={state} section={section} proposal={proposal} />
      {draft.restored ? <p className="draft-note">{messages.composer.draftRestored}</p> : null}
      <Form ref={form} className="form" onSubmit={submit} validationErrors={refused}>
        <MarkdownField
          name="text"
          label={messages.composer.versionLabel}
          hint={hint}
          value={values.text}
          onChange={(text) => {
            setSaid('');
            draft.update({ ...values, text });
          }}
          validate={versionCheck(current, proposal, missing)}
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

/** The section `atomId` names, with its number, or null when it isn't in the Document. */
function sectionOf(state: GroupState, atomId: string): Section | null {
  const index = state.atoms.findIndex((candidate) => candidate.id === atomId);
  const atom = state.atoms[index];
  return atom === undefined ? null : { atom, number: index + 1 };
}

/** What the composer writes for `atomId`: a version of its open Proposal, a change, or nothing. */
type Composing =
  | { readonly kind: 'missing' }
  | { readonly kind: 'version'; readonly section: Section | null; readonly proposal: Proposal }
  | { readonly kind: 'change'; readonly section: Section };

/**
 * A version while a Proposal is open on `atomId`, whether it changes a section
 * or adds one, whose Atom isn't in the Document until it passes (#75); else a
 * change to the section, or nothing when there's no such section.
 */
function composing(state: GroupState, atomId: string): Composing {
  const section = sectionOf(state, atomId);
  const open = openProposalOn(state, atomId);
  if (open !== undefined) return { kind: 'version', section, proposal: open };
  return section === null ? { kind: 'missing' } : { kind: 'change', section };
}

interface ChangeFormProps {
  readonly state: GroupState;
  readonly section: Section;
  readonly drafts: GroupDrafts;
  readonly onPropose: ComposerProps['onPropose'];
  /** The lapsed Proposal this proposes again, or undefined for a new one. */
  readonly again: Proposal | undefined;
}

/**
 * "Propose a change": new text for one section, beside the section as it
 * reads now. Proposing again (#74), it starts from the lapsed Proposal, and
 * its draft is kept under that Proposal, apart from the section's.
 */
function ChangeForm({ state, section, drafts, onPropose, again }: ChangeFormProps) {
  const { atom, number } = section;
  const { composer } = messages;
  const title = again === undefined ? composer.title : composer.againTitle;
  return (
    <ProposalForm
      state={state}
      place={{ atom: atom.id }}
      draftKey={again === undefined ? atom.id : againDraft(again.id)}
      start={again === undefined ? startOf(state, atom) : againStartOf(state, again)}
      drafts={drafts}
      onPropose={onPropose}
      words={{ title, pageTitle: composer.pageTitle, submit: composer.submit }}
      intro={
        <>
          <AgainLede again={again} />
          <CurrentText atom={atom} section={number} />
        </>
      }
      text={{ label: composer.textLabel, hint: composer.textHint, validate: textCheck(atom.text) }}
      again={again}
    />
  );
}

/**
 * The composer (`#/g/{groupId}/propose/{atomId}`; spec §8). On a section with
 * no open Proposal: a title, a why, the section's new text in Write and
 * Preview tabs (prefilled with the current text), and a discussion link
 * (prefilled with the group's latest one), and submitting queues one
 * `proposal`. On a section whose Proposal is open, or an add's open Proposal
 * (#75), "Add your version": the text alone, and submitting queues one
 * `version`. A full ballot takes no more. `composeOption` decides which, as it
 * does for the fold. What is typed is kept as a private draft on this device
 * until it is sent or discarded. Only someone who may propose sees a form
 * (`can()`).
 *
 * Proposing a lapsed Proposal again (#74) is the same form, starting from its
 * title, why, text and link, with its other versions carried onto the new
 * ballot. Its draft is kept under that Proposal, apart from the section's.
 */
export function Composer(props: ComposerProps) {
  const { state, me, atomId, drafts } = props;
  const what = composing(state, atomId);
  const { composer } = messages;
  if (what.kind === 'missing') {
    return <Unavailable state={state} title={composer.missingTitle} text={composer.missing} />;
  }
  if (!can(state, me, 'propose')) {
    // A suspended member reads until when, rather than that their level can't propose (#102).
    const text = suspendedLine(state, me) ?? composer.notAllowed;
    return <Unavailable state={state} title={composer.notAllowedTitle} text={text} />;
  }
  if (what.kind === 'change') {
    const again = lapsed(props.again);
    return (
      <ChangeForm
        key={again?.id ?? atomId}
        state={state}
        section={what.section}
        drafts={drafts}
        onPropose={props.onPropose}
        again={again}
      />
    );
  }
  if (composeOption(state, atomId) === 'ballot-full') {
    return <Unavailable state={state} title={composer.fullTitle} text={composer.full} />;
  }
  return (
    <VersionForm
      key={what.proposal.id}
      state={state}
      section={what.section}
      proposal={what.proposal}
      drafts={drafts}
      onAddVersion={props.onAddVersion}
    />
  );
}
