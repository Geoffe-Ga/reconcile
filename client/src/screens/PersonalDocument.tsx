import { type ReactNode, useCallback } from 'react';
import { Button, Dialog, DialogTrigger, Heading, Modal, ModalOverlay } from 'react-aria-components';

import { messages } from '../app/messages';
import type { PersonalSharing } from '../app/personalSharing';
import { ShareByLink } from '../app/ShareByLink';
import { AtomText } from '../app/text/AtomText';
import { MarkdownField } from '../app/text/MarkdownField';
import { BackLink, Field, PageHeader } from '../app/ui';
import {
  type PersonalDocuments,
  type PersonalSaving,
  type PersonalValues,
  usePersonalDocument,
} from '../app/usePersonalDocument';
import { useSaving } from '../app/useSaving';
import { type ShareByLinkState, useShareByLink } from '../app/useShareByLink';
import { normalizeAtomText } from '../engine/atomText';
import { nfcLength } from '../engine/text';
import { fitsShare } from '../share/copy';
import { PERSONAL_TITLE_MAX, type PersonalText } from '../store/personal';

/** Props for {@link PersonalDocument}. */
export interface PersonalDocumentProps {
  /** The Document's id, from `#/me/{id}`. */
  readonly id: string;
  /** Where this device keeps its personal Documents. */
  readonly documents: PersonalDocuments;
  /** The device clock, in ms, that stamps each save. It must stay the same function. */
  readonly now: () => number;
  /** Goes back to Personal once the Document is deleted from this device. */
  readonly onDeleted: () => void;
  /** Sharing by link (#105): off until the person turns it on for this Document. */
  readonly sharing: PersonalSharing;
}

/** Refuses a blank title, and one over 120 code points after NFC, never UTF-16 units. */
function checkTitle(value: string): string | null {
  const title = value.trim();
  if (title === '') return messages.personal.titleMissing;
  return nfcLength(title) > PERSONAL_TITLE_MAX
    ? messages.personal.titleTooLong(PERSONAL_TITLE_MAX)
    : null;
}

/** Always fine: a personal Document's text has no rule, and may be blank while it's written. */
function anyText(): null {
  return null;
}

/**
 * The text as it will read: normalized for Preview only, as #105 will before
 * it shares it, then rendered through the one renderer. The stored text stays
 * as typed, so normalizing never moves the cursor.
 */
function preview(value: string): ReactNode {
  const text = normalizeAtomText(value);
  return text === '' ? null : <AtomText text={text} />;
}

/** The live region's words for how the last save went. */
function savingLine(saving: PersonalSaving): string {
  if (saving === 'saved') return messages.personal.saved;
  return saving === 'held' ? messages.personal.notSaved : '';
}

/** What Delete needs: the title it names, whether it stops a share first (#105), and the delete. */
interface DeleteProps {
  readonly title: string;
  readonly shared: boolean;
  readonly onDelete: () => Promise<void>;
}

/** The dialog's body: the plain words, then Delete and Cancel. */
function DeleteBody({
  title,
  shared,
  onDelete,
  close,
}: DeleteProps & { readonly close: () => void }) {
  const { run, running, outcome } = useSaving(onDelete);
  const { personal } = messages;
  return (
    <div className="stack">
      <Heading slot="title" className="dialog-title">
        {personal.deleteBefore}
        <bdi>{title}</bdi>
        {personal.deleteAfter}
      </Heading>
      <p className="lede">{personal.deleteBody}</p>
      {shared ? <p className="lede">{personal.deleteShared}</p> : null}
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {shared ? personal.deleteSharedFailed : personal.deleteFailed}
        </p>
      ) : null}
      <div className="row form-actions">
        <Button
          className="button button-primary"
          onPress={() => {
            void run();
          }}
          isDisabled={running}
        >
          {personal.deleteConfirm}
        </Button>
        <Button className="button button-secondary" onPress={close} isDisabled={running}>
          {personal.deleteCancel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Delete, and the alert dialog it opens, which says plainly that a backup
 * saved earlier keeps the Document. Built as Leave this group is (#77), so
 * focus stays in the dialog, and Escape or Cancel deletes nothing.
 */
function DeleteDialog(props: DeleteProps) {
  return (
    <DialogTrigger>
      <Button className="button button-secondary">{messages.personal.delete}</Button>
      <ModalOverlay className="modal-overlay">
        <Modal className="modal">
          <Dialog role="alertdialog" className="dialog">
            {({ close }) => <DeleteBody {...props} close={close} />}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

/** Props for {@link KeptAndShared}. */
interface KeptAndSharedProps {
  /** The Document as last saved, or null before its first save. */
  readonly saved: PersonalText | null;
  /** The fields as typed. */
  readonly values: PersonalValues;
  readonly share: ShareByLinkState;
  readonly onDelete: () => Promise<void>;
}

/**
 * Under the fields: where the Document is kept, then, once it's saved, Share
 * by link (#105) and Delete. Whether the words as typed still fit a share is
 * worked out as they're typed, so a shared Document says when its link can't
 * keep up. A shared Document can't be deleted while the device's keys are
 * locked, since stopping its share needs them (#255), so Delete waits.
 */
function KeptAndShared({ saved, values, share, onDelete }: KeptAndSharedProps) {
  const { personal } = messages;
  const shared = share.view !== null && share.view !== undefined;
  const locked = share.view?.link === null;
  const fits = fitsShare({ title: values.title.trim(), text: normalizeAtomText(values.text) });
  return (
    <>
      <p className="caption">{shared ? personal.sharedPrivacy : personal.documentPrivacy}</p>
      {saved === null ? null : (
        <>
          <ShareByLink share={share} fits={fits} />
          {locked ? null : (
            <div>
              <DeleteDialog title={saved.title} shared={shared} onDelete={onDelete} />
            </div>
          )}
        </>
      )}
    </>
  );
}

/** The quiet link back to Personal, which every state of the editor starts with. */
function BackToPersonal() {
  return <BackLink to={{ name: 'personal' }} label={messages.personal.title} />;
}

/**
 * A personal Document (`#/me/{id}`; #93): a title (1 to 120 code points by
 * `nfcLength`) over the composer's Write and Preview tabs and hint, with no
 * why, no link and no Propose, since nobody votes on it. It saves on this
 * device about 500 ms after typing stops, and says "Saved on this device."
 * after each save. The first Document on a device opens as My mission
 * statement, with its prompt line, and is stored on its first save, not on
 * the visit. Delete asks first, in an alert dialog. The Document stays in
 * this device's IndexedDB and its backups, unless the person shares it by
 * link (#105): then its latest version goes, sealed, to the share's mailbox
 * when the share starts and each time the editor closes after an edit, and
 * Delete stops the share first.
 */
export function PersonalDocument({
  id,
  documents,
  now,
  onDeleted,
  sharing,
}: PersonalDocumentProps) {
  const onClose = useCallback(() => {
    sharing.leave(id);
  }, [sharing, id]);
  const editor = usePersonalDocument(documents, id, now, onClose);
  const share = useShareByLink(id, sharing, editor.save);
  const { personal } = messages;
  const { values, saved } = editor;
  if (editor.unreadable) {
    return (
      <main className="shell">
        <BackToPersonal />
        <PageHeader title={personal.title} pageTitle={personal.documentPageTitle} />
        <p role="alert" className="form-error">
          {personal.unreadable}
        </p>
      </main>
    );
  }
  // The Documents are read before the fields show, so nothing typed is ever replaced by them.
  if (values === null) return null;
  const set = (key: keyof PersonalValues) => (value: string) => {
    editor.update({ ...values, [key]: value });
  };
  const remove = async () => {
    await share.stopFirst();
    await editor.remove();
    onDeleted();
  };
  // The heading names the Document as saved, so a title being fixed never takes it over.
  const heading = saved?.title ?? (editor.offered ? personal.missionTitle : personal.untitled);
  return (
    <main className="shell">
      <BackToPersonal />
      <PageHeader
        eyebrow={personal.eyebrow}
        title={heading}
        pageTitle={personal.documentPageTitle}
      />
      {editor.offered ? <p className="lede">{personal.missionPrompt}</p> : null}
      <div className="form">
        <Field
          name="title"
          label={personal.titleLabel}
          autoComplete="off"
          isRequired
          validate={checkTitle}
          value={values.title}
          onChange={set('title')}
        />
        <MarkdownField
          name="text"
          label={personal.textLabel}
          hint={personal.textHint}
          value={values.text}
          onChange={set('text')}
          validate={anyText}
          preview={preview}
        />
      </div>
      <p role="status" className="status">
        {savingLine(editor.saving)}
      </p>
      {editor.saving === 'failed' ? (
        <p role="alert" className="form-error">
          {personal.failed}
        </p>
      ) : null}
      <KeptAndShared saved={saved} values={values} share={share} onDelete={remove} />
    </main>
  );
}
