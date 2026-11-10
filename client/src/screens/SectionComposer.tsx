/**
 * Composers that grow and prune the Document (#75; spec §8): Add a section,
 * which proposes a new section after one Atom or at the start, and Propose
 * removing this section, which proposes `""` for an Atom. A removal on a
 * section whose Proposal is open goes on that ballot as a version instead
 * (ADR-0004), so a removal and rewordings of one section compete side by side.
 */
import { type SyntheticEvent, useId } from 'react';
import { Button, Form } from 'react-aria-components';

import { againStartOf, lapsed, textCheck, useSend } from '../app/compose';
import { latestLink } from '../app/latestLink';
import { messages } from '../app/messages';
import { addDraft, againDraft, removalDraft, type VersionValues } from '../app/proposals';
import { WordDiff } from '../app/text/WordDiff';
import { BackLink, PageHeader } from '../app/ui';
import { suspendedLine } from '../app/stewardLines';
import { holdsRemoval } from '../app/versionViews';
import { can } from '../engine/capabilities';
import { composeOption, openProposalOn } from '../engine/composeOption';
import type { Atom, GroupState, Proposal } from '../engine/fold';
import type { GroupDrafts } from '../store/drafts';
import { AgainLede, type ComposerProps, CurrentText, ProposalForm, Unavailable } from './Composer';

/** Props for {@link AddSection}. */
export interface AddSectionProps {
  readonly state: GroupState;
  readonly me: string;
  /** The Atom the new section would follow, from the route, or null for the start. */
  readonly after: string | null;
  readonly drafts: GroupDrafts;
  /** The device clock now, in ms, which the voting time's closing line counts from (#106). */
  readonly now: number;
  readonly onPropose: ComposerProps['onPropose'];
  /** A lapsed add to propose again (#74), from the `again` route. */
  readonly again?: Proposal;
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

/**
 * Add a section (`#/g/{groupId}/add` for the start, `…/add/{atomId}` after an
 * Atom): a title, a why, the new section's text, starting empty, and a
 * discussion link. Submitting queues one add Proposal, which the fold places
 * after its anchor once it passes, or at the end if the anchor is gone by then.
 * Proposing a lapsed add again (#74) starts from it and carries its versions.
 */
export function AddSection({
  state,
  me,
  after,
  drafts,
  now,
  onPropose,
  ...props
}: AddSectionProps) {
  const index = after === null ? -1 : state.atoms.findIndex((atom) => atom.id === after);
  const atom = state.atoms[index];
  const { composer } = messages;
  if (after !== null && atom === undefined) {
    return <Unavailable state={state} title={composer.missingTitle} text={composer.missing} />;
  }
  if (!can(state, me, 'propose')) {
    // A suspended member reads until when, rather than that their level can't propose (#102).
    const text = suspendedLine(state, me) ?? composer.notAllowed;
    return <Unavailable state={state} title={composer.notAllowedTitle} text={text} />;
  }
  const anchor = atom === undefined ? null : { atom, number: index + 1 };
  const again = lapsed(props.again);
  const { draftKey, start } = formStart(state, addDraft(after), again);
  return (
    <ProposalForm
      key={draftKey}
      state={state}
      place={{ target: { kind: 'add', after } }}
      draftKey={draftKey}
      start={start}
      drafts={drafts}
      now={now}
      onPropose={onPropose}
      words={formWords(composer.addTitle, composer.addPageTitle, composer.addSubmit, again)}
      intro={
        <>
          <AgainLede again={again} />
          <AddIntro anchor={anchor} />
        </>
      }
      again={again}
      text={{
        label: composer.addTextLabel,
        hint: composer.addTextHint,
        validate: textCheck('', composer.addTextMissing),
      }}
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
function unavailable(state: GroupState, me: string, atomId: string) {
  const { composer } = messages;
  const open = openProposalOn(state, atomId);
  if (!can(state, me, 'propose')) {
    return {
      title: composer.notAllowedTitle,
      text: suspendedLine(state, me) ?? composer.notAllowed,
    };
  }
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
  const { state, me, atomId, drafts } = props;
  const index = state.atoms.findIndex((candidate) => candidate.id === atomId);
  const atom = state.atoms[index];
  const { composer } = messages;
  if (atom === undefined) {
    return <Unavailable state={state} title={composer.missingTitle} text={composer.missing} />;
  }
  const reason = unavailable(state, me, atomId);
  if (reason !== null) return <Unavailable state={state} title={reason.title} text={reason.text} />;
  const open = openProposalOn(state, atomId);
  if (open !== undefined) {
    return (
      <RemovalVersion
        key={open.id}
        state={state}
        atom={atom}
        section={index + 1}
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
          <StruckSection atom={atom} section={index + 1} />
        </>
      }
      text={null}
      again={again}
    />
  );
}
