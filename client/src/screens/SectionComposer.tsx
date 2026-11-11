/**
 * Composers that grow and prune the Document (#75; spec §8): Add a section,
 * which proposes a new section after one Atom or at the start, or a section
 * header or subsection header there, written as one Heading line (#103), and
 * Propose removing this section, which proposes `""` for an Atom. A removal
 * on a section whose Proposal is open goes on that ballot as a version
 * instead (ADR-0004), so a removal and rewordings of one section compete side
 * by side.
 */
import { type SyntheticEvent, useId } from 'react';
import { Button, Form } from 'react-aria-components';

import { documentBack, groupBack } from '../app/backLinks';
import {
  againStartOf,
  lapsed,
  textCheck,
  useSend,
  whyNoForm,
  whySectionWaits,
} from '../app/compose';
import { documentNamed, sectionPlace } from '../app/documentLines';
import { latestLink } from '../app/latestLink';
import { messages } from '../app/messages';
import { addDraft, againDraft, removalDraft, type VersionValues } from '../app/proposals';
import { WordDiff } from '../app/text/WordDiff';
import { BackLink, Field, PageHeader } from '../app/ui';
import { holdsRemoval } from '../app/versionViews';
import type { HeadingLevel } from '../engine/atomText';
import { composeOption, openProposalOn } from '../engine/composeOption';
import type { GroupDocument } from '../engine/documents';
import type { Atom, GroupState, Proposal } from '../engine/fold';
import type { Draft, GroupDrafts } from '../store/drafts';
import {
  AgainLede,
  type ComposerProps,
  CurrentText,
  EntrenchedNote,
  ProposalForm,
  Unavailable,
} from './Composer';

/** Props for {@link AddSection}. */
export interface AddSectionProps {
  readonly state: GroupState;
  readonly me: string;
  /** The Atom the new section would follow, from the route, or null for the start. */
  readonly after: string | null;
  /**
   * The Document whose start it goes at when `after` is null (#92), from the
   * route; the group's first when absent. An anchor's own Document wins.
   */
  readonly document?: string;
  readonly drafts: GroupDrafts;
  /** The device clock now, in ms, which the voting time's closing line counts from (#106). */
  readonly now: number;
  readonly onPropose: ComposerProps['onPropose'];
  /** A lapsed add to propose again (#74), from the `again` route. */
  readonly again?: Proposal;
  /** Whether this device's leave waits for the relay (#77): then it shows no form. */
  readonly leaving?: boolean;
  /** A section header (1) or a subsection header (2), from the route (#103); a section when absent. */
  readonly heading?: HeadingLevel;
}

/** A blank title, why and text, and the group's latest link: where a new add or removal starts. */
function blankStart(state: GroupState) {
  return { title: '', why: '', text: '', link: latestLink(state) ?? '' };
}

/** How a form starts, and the draft it's kept in: fresh, or proposing a lapsed one again (#74). */
function formStart(state: GroupState, draftKey: string, again: Proposal | undefined) {
  if (again === undefined) return { draftKey, start: blankStart(state) };
  return { draftKey: againDraft(again.id), start: againStartOf(state, again) };
}

/** A form's words; its heading reads Propose again when it repeats a lapsed Proposal. */
function formWords(title: string, pageTitle: string, submit: string, again: Proposal | undefined) {
  return { title: again === undefined ? title : messages.composer.againTitle, pageTitle, submit };
}

/** Where the new section goes, and the section it follows as it reads now. */
function AddIntro({ anchor }: { readonly anchor: { atom: Atom; number: number } | null }) {
  const { composer } = messages;
  if (anchor === null) return <p className="lede">{composer.addAtStart}</p>;
  return (
    <>
      <p className="lede">{composer.addAfter(anchor.number)}</p>
      <CurrentText atom={anchor.atom} section={anchor.number} />
    </>
  );
}

/** Where a new section goes (#92): its Document, and the section it follows there, if any. */
interface AddSpot {
  readonly document: GroupDocument;
  readonly anchor: { readonly atom: Atom; readonly number: number } | null;
}

/**
 * Where Add a section puts its section: after the anchor, in the anchor's
 * Document, or at the start of the Document the route names, or of the
 * group's first; null when the anchor or the Document isn't in the group.
 */
function addSpot(state: GroupState, after: string | null, document?: string): AddSpot | null {
  if (after !== null) {
    const place = sectionPlace(state, after);
    if (place === null) return null;
    return { document: place.document, anchor: { atom: place.atom, number: place.number } };
  }
  const named = documentNamed(state, document);
  return named === undefined ? null : { document: named, anchor: null };
}

/** What a header's one line starts with (#103): `# ` for a section header, `## ` for a subsection header. */
function headingPrefix(level: HeadingLevel): string {
  return level === 1 ? '# ' : '## ';
}

/** The Proposal title a heading prefills (#103), or none for a blank one. */
function headingTitle(level: HeadingLevel, heading: string): string {
  const { composer } = messages;
  const words = heading.trim();
  if (words === '') return '';
  return level === 1 ? composer.headerProposalTitle(words) : composer.subheaderProposalTitle(words);
}

/** A blank heading is refused (#103). */
function checkHeading(value: string): string | null {
  return value.trim() === '' ? messages.composer.headingMissing : null;
}

interface HeadingFieldProps {
  readonly level: HeadingLevel;
  readonly values: Draft;
  readonly onChange: (values: Draft) => void;
}

/**
 * A header's one Heading line, in place of the textarea (#103). The draft's
 * text holds it as written, after its `#` or `##`, so `propose` signs
 * `# <heading>\n`. While the title is blank or still the one the heading
 * last prefilled, it follows the heading; once changed by hand, it stays.
 */
function HeadingField({ level, values, onChange }: HeadingFieldProps) {
  const { composer } = messages;
  const prefix = headingPrefix(level);
  const heading = values.text.startsWith(prefix) ? values.text.slice(prefix.length) : '';
  const change = (next: string) => {
    const follows = values.title === '' || values.title === headingTitle(level, heading);
    const text = next === '' ? '' : `${prefix}${next}`;
    onChange({ ...values, text, title: follows ? headingTitle(level, next) : values.title });
  };
  return (
    <Field
      name="heading"
      label={composer.headingLabel}
      hint={level === 1 ? composer.headerHint : composer.subheaderHint}
      autoComplete="off"
      isRequired
      validate={checkHeading}
      value={heading}
      onChange={change}
    />
  );
}

/** The words of Add a section's form: a section's, or a header's of `heading`'s level (#103). */
function addWords(heading: HeadingLevel | undefined, again: Proposal | undefined) {
  const { composer } = messages;
  if (heading === undefined) {
    return formWords(composer.addTitle, composer.addPageTitle, composer.addSubmit, again);
  }
  const header = heading === 1;
  return formWords(
    header ? composer.headerTitle : composer.subheaderTitle,
    header ? composer.headerPageTitle : composer.subheaderPageTitle,
    composer.headerSubmit,
    again,
  );
}

/**
 * Add a section (`#/g/{groupId}/add` for the start of the first Document,
 * `…/add-first/{documentId}` for the start of another (#92), `…/add/{atomId}`
 * after an Atom, in its Document): a title, a why, the new section's text,
 * starting empty, and a discussion link. Submitting queues one add Proposal
 * naming its Document, which the fold places after its anchor once it
 * passes, or at the end of that Document if the anchor is gone by then.
 * Proposing a lapsed add again (#74) starts from it and carries its versions.
 * A header (`…/add-header/…`, `…/add-subheader/…` and their `add-first-`
 * forms, #103) has one Heading line in place of the text, and its own draft.
 */
export function AddSection({
  state,
  me,
  after,
  drafts,
  now,
  onPropose,
  heading,
  ...props
}: AddSectionProps) {
  const { composer, documents } = messages;
  const spot = addSpot(state, after, props.document);
  if (spot === null) {
    // A gone anchor is a missing section; a start in no Document is a missing Document (#92).
    const missing =
      after === null
        ? { title: documents.missingTitle, text: documents.missing }
        : { title: composer.missingTitle, text: composer.missing };
    return <Unavailable state={state} {...missing} back={groupBack(state)} />;
  }
  const refused = whyNoForm({ state, me, ...props });
  if (refused !== null) {
    return <Unavailable state={state} {...refused} back={documentBack(state, spot.document.id)} />;
  }
  const target = { kind: 'add', document: spot.document.id, after } as const;
  const again = lapsed(props.again);
  const { draftKey, start } = formStart(state, addDraft(target, heading), again);
  return (
    <ProposalForm
      key={draftKey}
      state={state}
      place={{ target }}
      draftKey={draftKey}
      start={start}
      drafts={drafts}
      now={now}
      onPropose={onPropose}
      words={addWords(heading, again)}
      intro={
        <>
          <AgainLede again={again} />
          <AddIntro anchor={spot.anchor} />
        </>
      }
      again={again}
      text={{
        label: composer.addTextLabel,
        hint: composer.addTextHint,
        validate: textCheck('', composer.addTextMissing),
      }}
      {...(heading === undefined
        ? {}
        : {
            heading,
            field: (values: Draft, onChange: (next: Draft) => void) => (
              <HeadingField level={heading} values={values} onChange={onChange} />
            ),
          })}
    />
  );
}

/** The section as it reads now, struck through whole: what a removal takes out. */
function StruckSection({ atom, section }: { readonly atom: Atom; readonly section: number }) {
  const heading = useId();
  return (
    <section className="text-block" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {messages.composer.current(section)}
      </h2>
      <WordDiff current={atom.text} proposed="" />
    </section>
  );
}

/** Props for {@link RemoveSection}. */
export interface RemoveSectionProps {
  readonly state: GroupState;
  readonly me: string;
  /** The Atom to remove, from the route. */
  readonly atomId: string;
  readonly drafts: GroupDrafts;
  /** The device clock now, in ms, which the voting time's closing line counts from (#106). */
  readonly now: number;
  readonly onPropose: ComposerProps['onPropose'];
  readonly onAddVersion: ComposerProps['onAddVersion'];
  /** A lapsed removal to propose again (#74), from the `again` route. */
  readonly again?: Proposal;
  /** Whether this device's leave waits for the relay (#77): then it shows no form. */
  readonly leaving?: boolean;
}

interface RemovalVersionProps {
  readonly state: GroupState;
  readonly atom: Atom;
  readonly section: number;
  readonly proposal: Proposal;
  readonly onAddVersion: ComposerProps['onAddVersion'];
}

/**
 * Removing a section whose Proposal is open: no title or why, since it joins
 * that ballot as a version whose text is `""`, and keeps no draft.
 */
function RemovalVersion({ state, atom, section, proposal, onAddVersion }: RemovalVersionProps) {
  const { run, running, failed } = useSend<VersionValues>(onAddVersion, null);
  const { composer } = messages;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run({ proposal: proposal.id, text: '' });
  };
  const groupId = state.group ?? '';
  return (
    <main className="shell">
      <BackLink
        to={{ name: 'proposal', groupId, proposalId: proposal.id }}
        label={proposal.title}
      />
      <PageHeader title={composer.removeTitle} pageTitle={composer.removePageTitle} />
      <p className="lede">{composer.removeVersionLede}</p>
      <StruckSection atom={atom} section={section} />
      <Form className="form" onSubmit={submit}>
        <p className="caption">{composer.removeVersionVisibility}</p>
        {failed ? (
          <p role="alert" className="form-error">
            {composer.versionFailed}
          </p>
        ) : null}
        <div className="row form-actions">
          <Button type="submit" className="button button-primary" isDisabled={running}>
            {composer.removeVersionSubmit}
          </Button>
        </div>
      </Form>
    </main>
  );
}

/** Why there's no removal to write for a section in the Document, or null when there is one. */
function unavailable(props: RemoveSectionProps) {
  const { state, atomId } = props;
  const { composer } = messages;
  const open = openProposalOn(state, atomId);
  const refused = whyNoForm(props) ?? whySectionWaits(state, atomId);
  if (refused !== null) return refused;
  if (composeOption(state, atomId) === 'ballot-full') {
    return { title: composer.fullTitle, text: composer.full };
  }
  return open !== undefined && holdsRemoval(open)
    ? { title: composer.removalOnBallotTitle, text: composer.removalOnBallot }
    : null;
}

/**
 * Propose removing this section (`#/g/{groupId}/remove/{atomId}`): a title,
 * a why and a discussion link beside the section struck through, which queues
 * an edit whose text is `""`. While the section has an open Proposal, the
 * same screen without title and why adds `""` to its ballot as a version.
 */
export function RemoveSection(props: RemoveSectionProps) {
  const { state, atomId, drafts } = props;
  const place = sectionPlace(state, atomId);
  const { composer } = messages;
  if (place === null) {
    return <Unavailable state={state} title={composer.missingTitle} text={composer.missing} />;
  }
  const { atom, number } = place;
  const back = documentBack(state, place.document.id);
  const reason = unavailable(props);
  if (reason !== null) {
    return <Unavailable state={state} title={reason.title} text={reason.text} back={back} />;
  }
  const open = openProposalOn(state, atomId);
  if (open !== undefined) {
    return (
      <RemovalVersion
        key={open.id}
        state={state}
        atom={atom}
        section={number}
        proposal={open}
        onAddVersion={props.onAddVersion}
      />
    );
  }
  const again = lapsed(props.again);
  const { draftKey, start } = formStart(state, removalDraft(atomId), again);
  return (
    <ProposalForm
      key={draftKey}
      state={state}
      place={{ atom: atomId }}
      draftKey={draftKey}
      start={start}
      drafts={drafts}
      now={props.now}
      onPropose={props.onPropose}
      words={formWords(
        composer.removeTitle,
        composer.removePageTitle,
        composer.removeSubmit,
        again,
      )}
      intro={
        <>
          <AgainLede again={again} />
          <p className="lede">{composer.removeLede}</p>
          <EntrenchedNote state={state} atom={atom} />
          <StruckSection atom={atom} section={number} />
        </>
      }
      text={null}
      again={again}
    />
  );
}
