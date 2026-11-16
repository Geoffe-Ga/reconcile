/**
 * Propose a new Document (#92; spec §8): a title, a why, the new Document's
 * title, its first sections in Write and Preview tabs, a discussion link, the
 * voting time (#106) and an optional Dispatch (#112). Submitting queues one
 * `proposal` with `target: {kind: "new-document", title}`, whose text the
 * fold splits into the new Document's sections once it passes. Other
 * wordings join its ballot as versions (ADR-0004), through Add your version.
 */
import { groupBack } from '../app/backLinks';
import { againStartOf, lapsed, whyNoForm } from '../app/compose';
import { latestLink } from '../app/latestLink';
import { messages } from '../app/messages';
import { againDraft, NEW_DOCUMENT_DRAFT } from '../app/proposals';
import { sectionsCheck, sectionsPreview } from '../app/sectionsPreview';
import type { GroupState, Proposal } from '../engine/fold';
import type { Draft, GroupDrafts } from '../store/drafts';
import {
  AgainLede,
  type ComposerProps,
  ProposalForm,
  type TextEntry,
  Unavailable,
} from './Composer';

/** Props for {@link NewDocumentComposer}. */
export interface NewDocumentComposerProps {
  readonly state: GroupState;
  readonly me: string;
  readonly drafts: GroupDrafts;
  /** The device clock now, in ms, which the voting time's closing line counts from (#106). */
  readonly now: number;
  readonly onPropose: ComposerProps['onPropose'];
  /** A lapsed new Document to propose again (#74), from the `again` route. */
  readonly again?: Proposal;
  /** Whether this device's leave waits for the relay (#77): then it shows no form. */
  readonly leaving?: boolean;
}

/** The first sections' field: its label, hint, check and numbered preview. */
const SECTIONS: TextEntry = {
  label: messages.composer.sectionsLabel,
  hint: messages.composer.sectionsHint,
  validate: sectionsCheck(messages.composer.sectionsMissing),
  preview: sectionsPreview,
};

/**
 * Where the form starts, and the draft it's kept in: blank, under the
 * group's one new-Document draft, or a lapsed new Document's title, words and
 * Dispatch, under its own (#74).
 */
function formStart(state: GroupState, again: Proposal | undefined) {
  if (again === undefined) {
    const start: Draft = { title: '', why: '', text: '', link: latestLink(state) ?? '' };
    return { draftKey: NEW_DOCUMENT_DRAFT, start: { ...start, documentTitle: '' } };
  }
  const title = again.target.kind === 'new-document' ? again.target.title : '';
  return {
    draftKey: againDraft(again.id),
    start: { ...againStartOf(state, again), documentTitle: title },
  };
}

/**
 * Propose a new Document (`#/g/{groupId}/doc/new`): only someone who may
 * propose, and isn't leaving, gets the form (`can()`); anyone else reads why.
 * Its draft is kept on this device under the group's `new-document` key.
 */
export function NewDocumentComposer(props: NewDocumentComposerProps) {
  const { state, drafts, now, onPropose } = props;
  const { composer } = messages;
  const refused = whyNoForm(props);
  if (refused !== null) return <Unavailable state={state} {...refused} back={groupBack(state)} />;
  const again = lapsed(props.again);
  const { draftKey, start } = formStart(state, again);
  const title = again === undefined ? composer.newDocumentTitle : composer.againTitle;
  return (
    <ProposalForm
      key={draftKey}
      state={state}
      place={{ target: { kind: 'new-document', title: start.documentTitle } }}
      draftKey={draftKey}
      start={start}
      drafts={drafts}
      now={now}
      onPropose={onPropose}
      words={{
        title,
        pageTitle: composer.newDocumentPageTitle,
        submit: composer.newDocumentSubmit,
      }}
      intro={
        <>
          <AgainLede again={again} />
          <p className="lede">{composer.newDocumentLede}</p>
        </>
      }
      text={SECTIONS}
      again={again}
    />
  );
}
