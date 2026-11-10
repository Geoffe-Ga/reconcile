import type { ReactNode } from 'react';
import { Button, Dialog, DialogTrigger, Heading, Modal, ModalOverlay } from 'react-aria-components';

import { messages } from '../app/messages';
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
import { normalizeAtomText } from '../engine/atomText';
import { nfcLength } from '../engine/text';
import { PERSONAL_TITLE_MAX } from '../store/personal';

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

/** The dialog's body: the plain words, then Delete and Cancel. */
function DeleteBody({
  title,
  onDelete,
  close,
}: {
  readonly title: string;
  readonly onDelete: () => Promise<void>;
  readonly close: () => void;
}) {
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
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {personal.deleteFailed}
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
function DeleteDialog({
  title,
  onDelete,
}: {
  readonly title: string;
  readonly onDelete: () => Promise<void>;
}) {
  return (
    <DialogTrigger>
      <Button className="button button-secondary">{messages.personal.delete}</Button>
      <ModalOverlay className="modal-overlay">
        <Modal className="modal">
          <Dialog role="alertdialog" className="dialog">
            {({ close }) => <DeleteBody title={title} onDelete={onDelete} close={close} />}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
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
 * the visit. Delete asks first, in an alert dialog. Nothing here reaches the
 * network: the Document stays in this device's IndexedDB and its backups.
 */
export function PersonalDocument({ id, documents, now, onDeleted }: PersonalDocumentProps) {
  const editor = usePersonalDocument(documents, id, now);
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
      <p className="caption">{personal.documentPrivacy}</p>
      {saved === null ? null : (
        <div>
          <DeleteDialog title={saved.title} onDelete={remove} />
        </div>
      )}
    </main>
  );
}
