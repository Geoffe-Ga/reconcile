import { type ReactNode, type SyntheticEvent, useId, useRef, useState } from 'react';
import { Button, CheckboxButton, CheckboxField, Form, Text } from 'react-aria-components';

import {
  againStartOf,
  type ComposeOutcome,
  lapsed,
  textCheck,
  useSend,
  whyNoForm,
} from '../app/compose';
import { DocumentLine } from '../app/DocumentLine';
import { type Back, documentBack, groupBack } from '../app/backLinks';
import { documentLead, sectionPlace } from '../app/documentLines';
import { latestLink } from '../app/latestLink';
import { isHttpLink } from '../app/links';
import { messages } from '../app/messages';
import { checkDispatchText, checkDispatchTitle } from '../app/proposalFields';
import {
  againDraft,
  type ProposalPlace,
  type ProposalValues,
  type VersionValues,
} from '../app/proposals';
import { AtomText } from '../app/text/AtomText';
import { MarkdownField } from '../app/text/MarkdownField';
import { BackLink, Field, PageHeader } from '../app/ui';
import { sectionsPreview } from '../app/sectionsPreview';
import { useDraft } from '../app/useDraft';
import { versionDoes } from '../app/versionViews';
import { WindowField } from '../app/WindowField';
import { normalizeAtomText } from '../engine/atomText';
import { composeOption, openProposalOn } from '../engine/composeOption';
import { DOCUMENT_TITLE_MAX, documentTitle } from '../engine/documents';
import { type Atom, type GroupState, type Proposal, TITLE_MAX, WHY_MAX } from '../engine/fold';
import { type ProposalClass, targetClass } from '../engine/rules';
import { nfcLength } from '../engine/text';
import type { Draft, DraftDispatch, GroupDrafts } from '../store/drafts';

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
/** A new Document's title (#92): not blank, and as long as the fold takes. */
const checkDocumentTitle = required(
  messages.composer.documentTitleMissing,
  DOCUMENT_TITLE_MAX,
  messages.composer.documentTitleTooLong(DOCUMENT_TITLE_MAX),
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

/** True when a Proposal proposes a new Document (#92), whose title its draft holds. */
function proposesDocument(place: ProposalPlace): boolean {
  return 'target' in place && place.target.kind === 'new-document';
}

/** Where the Proposal goes, a new Document's title taken from the draft, trimmed (#92). */
function placeFor(place: ProposalPlace, draft: Draft): ProposalPlace {
  if (!proposesDocument(place)) return place;
  return { target: { kind: 'new-document', title: (draft.documentTitle ?? '').trim() } };
}

/**
 * The entries as the Proposal takes them: title, why and link trimmed, a
 * blank link none, and any Dispatch's title and text trimmed (#112).
 */
function toValues(draft: Draft, place: ProposalPlace, window: number): ProposalValues {
  const link = draft.link.trim();
  const { dispatch } = draft;
  return {
    ...placeFor(place, draft),
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
function withoutDispatch({ title, why, text, link, window, documentTitle }: Draft): Draft {
  return {
    title,
    why,
    text,
    link,
    ...(window === undefined ? {} : { window }),
    ...(documentTitle === undefined ? {} : { documentTitle }),
  };
}

/**
 * Where a composer's Back goes (#92): the Document its section or new section
 * is in, or Group home for a new Document, which no Document holds yet.
 */
function backFor(state: GroupState, place: ProposalPlace): Back {
  if (!('target' in place))
    return documentBack(state, sectionPlace(state, place.atom)?.document.id);
  const { target } = place;
  return target.kind === 'add' ? documentBack(state, target.document) : groupBack(state);
}

/**
 * Where a carried Dispatch's title starts (#112): "Updated: <title>" of the
 * Document the Proposal changes, or "New Document: <title>" for a new one (#92).
 */
function dispatchStart(state: GroupState, values: Draft, place: ProposalPlace): string {
  const { composer } = messages;
  if (proposesDocument(place))
    return composer.dispatchNewTitle((values.documentTitle ?? '').trim());
  const id = 'target' in place && place.target.kind === 'add' ? place.target.document : undefined;
  const changed = 'atom' in place ? sectionPlace(state, place.atom)?.document.id : id;
  return composer.dispatchTitle(documentTitle(state, changed ?? null) ?? '');
}

/** The class `targetClass` gives this Proposal as it stands, which bounds its voting time. */
function classOf(state: GroupState, draft: Draft, place: ProposalPlace): ProposalClass {
  return targetClass(state, { ...place, title: draft.title, why: draft.why, text: draft.text });
}

/** The voting time to show and send: the draft's, or else its class's default. */
function windowOf(state: GroupState, draft: Draft, place: ProposalPlace): number {
  return draft.window ?? state.rules.windows[classOf(state, draft, place)].default;
}

/** Where a new composer starts: a blank title and why, the section's text, the latest link. */
function startOf(state: GroupState, atom: Atom): Draft {
  return { title: '', why: '', text: atom.text, link: latestLink(state) ?? '' };
}

/** The entries as the Proposal takes them, and, proposing again, the other versions' texts too. */
function valuesOf(
  draft: Draft,
  place: ProposalPlace,
  again: Proposal | undefined,
  window: number,
): ProposalValues {
  const values = toValues(draft, place, window);
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
  /** Where Back goes: the group's first Document when absent. */
  readonly back?: Back;
}

/** Shown in place of the form when there's nothing here to propose on. */
export function Unavailable({ state, title, text, back = documentBack(state) }: UnavailableProps) {
  return (
    <main className="shell">
      <BackLink to={back.to} label={back.label} />
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

/** The text field of a Proposal's form: its label, its hint, its check and how Preview shows it. */
export interface TextEntry {
  readonly label: string;
  readonly hint: string;
  readonly validate: (value: string) => string | null;
  /** Preview's view of the text, the new text as it will read when absent. */
  readonly preview?: (value: string) => ReactNode;
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
  readonly values: Draft;
  /** Where the Dispatch's title starts once it's checked. */
  readonly start: string;
  readonly onChange: (values: Draft) => void;
}

/**
 * "Send a Dispatch if this passes" (#112), a React Aria checkbox, unchecked
 * to start. Checked, it opens the Dispatch's title, which starts as
 * 'Updated: {Document title}' ('New Document: {title}' for a new one, #92),
 * and its text, both kept in the draft.
 */
function DispatchChoice({ values, start, onChange }: DispatchChoiceProps) {
  const { composer } = messages;
  const { dispatch } = values;
  const toggle = (on: boolean) => {
    const opened = { title: start, text: '' };
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
  /** The text field, or null for a removal, whose text is `""` (#75). */
  readonly text: TextEntry | null;
  /** Where the Proposal goes, whose class bounds its voting time (#106). */
  readonly place: ProposalPlace;
  readonly now: number;
  readonly onChange: (values: Draft) => void;
}

/** A new Document's title (#92), between the why and its first sections, kept in the draft. */
function DocumentTitleField({ values, onChange }: Pick<FieldsProps, 'values' | 'onChange'>) {
  const { composer } = messages;
  return (
    <Field
      name="documentTitle"
      label={composer.documentTitleLabel}
      hint={composer.documentTitleHint}
      autoComplete="off"
      isRequired
      validate={checkDocumentTitle}
      value={values.documentTitle ?? ''}
      onChange={(documentTitle) => {
        onChange({ ...values, documentTitle });
      }}
    />
  );
}

/**
 * The four entries, or three for a removal (#75) and five for a new Document,
 * whose title comes after the why (#92), the voting time and any Dispatch it
 * carries (#112), each kept in the draft as it changes.
 */
function Fields({ state, values, text, place, now, onChange }: FieldsProps) {
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
      {proposesDocument(place) ? <DocumentTitleField values={values} onChange={onChange} /> : null}
      {text === null ? null : (
        <MarkdownField
          name="text"
          label={text.label}
          hint={text.hint}
          value={values.text}
          onChange={set('text')}
          validate={text.validate}
          isRequired
          preview={text.preview ?? preview}
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
      <WindowField
        rules={state.rules}
        cls={classOf(state, values, place)}
        value={windowOf(state, values, place)}
        onChange={(window) => {
          onChange({ ...values, window });
        }}
        now={now}
      />
      <DispatchChoice
        values={values}
        start={dispatchStart(state, values, place)}
        onChange={onChange}
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
  /** The device clock now, in ms, which the voting time's closing line counts from (#106). */
  readonly now: number;
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
 * A Proposal's form: a title, a why, the text (unless it removes a section),
 * a discussion link and the voting time (#106), kept as a private draft until
 * it is proposed, with Discard draft once it has changed. Submitting queues
 * one `proposal`, and proposing again, one `version` for each of the lapsed
 * Proposal's others.
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
    void run(valuesOf(values, place, props.again, windowOf(state, values, place)));
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
  const back = backFor(state, place);
  return (
    <main className="shell">
      <BackLink to={back.to} label={back.label} />
      <PageHeader title={words.title} pageTitle={words.pageTitle} />
      {props.intro}
      {draft.restored ? <p className="draft-note">{messages.composer.draftRestored}</p> : null}
      <Form ref={form} className="form" onSubmit={submit} validationErrors={refused}>
        <Fields
          state={state}
          values={values}
          text={props.text}
          place={place}
          now={props.now}
          onChange={change}
        />
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

/**
 * What sits above a version's text: the section as it reads now, where an
 * add's section goes, or the new Document a new Document's version would
 * start (#92).
 */
function VersionIntro({
  state,
  section,
  proposal,
}: Omit<VersionFormProps, 'drafts' | 'onAddVersion'>) {
  const { composer } = messages;
  if (section !== null) {
    return (
      <>
        <p className="lede">{composer.versionLede}</p>
        <CurrentText atom={section.atom} section={section.number} />
      </>
    );
  }
  if (proposal.target.kind === 'new-document') {
    return (
      <>
        <p className="lede">{composer.newDocumentVersionLede}</p>
        <DocumentLine lead={documentLead(state, proposal)} groupId={state.group ?? ''} />
      </>
    );
  }
  return (
    <>
      <p className="lede">{composer.addVersionLede}</p>
      <p className="version-does">{versionDoes(state, proposal.target, proposal.text)}</p>
    </>
  );
}

/**
 * What a version rewords and starts from, and its field's hint, blank refusal
 * and preview: the section as it reads now, or for an add or a new Document
 * (#92), nothing to reword and the Proposal's own text to start from, a new
 * Document's previewed as its numbered sections.
 */
function versionWords(section: Section | null, proposal: Proposal) {
  const { composer } = messages;
  if (proposal.target.kind === 'new-document') {
    const words = { hint: composer.newDocumentVersionHint, missing: composer.sectionsMissing };
    return { current: '', start: proposal.text, ...words, preview: sectionsPreview };
  }
  if (section === null) {
    const add = { hint: composer.addVersionHint, missing: composer.addTextMissing };
    return { current: '', start: proposal.text, ...add, preview };
  }
  const { text } = section.atom;
  return {
    current: text,
    start: text,
    hint: composer.versionHint,
    missing: composer.versionMissing,
    preview,
  };
}

/**
 * "Add your version" (ADR-0004): the new text alone, for the section's open
 * Proposal, starting from the section as it reads now, or for an add (#75),
 * from the Proposal's own text. Its draft is kept under the Proposal, apart
 * from any Proposal drafted for the section.
 */
function VersionForm({ state, section, proposal, drafts, onAddVersion }: VersionFormProps) {
  const words = versionWords(section, proposal);
  const { current, start, hint, missing } = words;
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
          preview={words.preview}
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

/** The section `atomId` names, with its number in its own Document (#92), or null when it isn't in one. */
function sectionOf(state: GroupState, atomId: string): Section | null {
  const place = sectionPlace(state, atomId);
  return place === null ? null : { atom: place.atom, number: place.number };
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
  readonly now: number;
  readonly onPropose: ComposerProps['onPropose'];
  /** The lapsed Proposal this proposes again, or undefined for a new one. */
  readonly again: Proposal | undefined;
}

/**
 * "Propose a change": new text for one section, beside the section as it
 * reads now. Proposing again (#74), it starts from the lapsed Proposal, and
 * its draft is kept under that Proposal, apart from the section's.
 */
function ChangeForm({ state, section, drafts, now, onPropose, again }: ChangeFormProps) {
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
      now={now}
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
 * Preview tabs (prefilled with the current text), a discussion link
 * (prefilled with the group's latest one), the voting time in days (the
 * class default, within its bounds; #106), and "Send a Dispatch if this
 * passes" (#112), and submitting queues one `proposal`. On a section whose
 * Proposal is open, or an add's open Proposal (#75), "Add your version": the
 * text alone, and submitting queues one `version`, which runs in its
 * Proposal's window. A full ballot takes no
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
  const what = composing(state, atomId);
  const { composer } = messages;
  if (what.kind === 'missing') {
    return <Unavailable state={state} title={composer.missingTitle} text={composer.missing} />;
  }
  const refused = whyNoForm(props);
  if (refused !== null) return <Unavailable state={state} {...refused} />;
  if (what.kind === 'change') {
    const again = lapsed(props.again);
    return (
      <ChangeForm
        key={again?.id ?? atomId}
        state={state}
        section={what.section}
        drafts={drafts}
        now={props.now}
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
