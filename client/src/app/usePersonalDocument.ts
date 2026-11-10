/**
 * `usePersonalDocument`: one personal Document as its editor holds it (#93),
 * read once when the editor opens and saved on this device about half a
 * second after typing stops, and when the editor closes.
 *
 * There is no draft and no vote: each save is the Document. Text saves as
 * typed, never normalized, so the cursor never moves. A title that isn't 1 to
 * 120 code points holds saving until it is, and the editor says so. A
 * Document that has never been saved isn't stored, so opening one stores
 * nothing. Delete drops any save still waiting first, so none can bring the
 * Document back. Nothing here touches the network.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { isPersonalTitle, type PersonalDocument, type PersonalStore } from '../store/personal';
import { messages } from './messages';
import { DRAFT_SAVE_DELAY_MS } from './useDraft';

/** Where the editor's Documents are kept: the device's store, or anything that keeps them like it. */
export type PersonalDocuments = Pick<
  PersonalStore,
  'listPersonal' | 'savePersonal' | 'deletePersonal'
>;

/** What the editor's two fields hold, as typed. */
export interface PersonalValues {
  readonly title: string;
  readonly text: string;
}

/** How the last save went: none yet, saved, held for a title, or failed. */
export type PersonalSaving = 'none' | 'saved' | 'held' | 'failed';

/** One personal Document, as `usePersonalDocument` keeps it. */
export interface PersonalEditor {
  /** The values to show, or null until the device's Documents have been read. */
  readonly values: PersonalValues | null;
  /** Whether the device's Documents couldn't be read: then there's nothing to edit. */
  readonly unreadable: boolean;
  /** Whether it was offered as the device's first Document, My mission statement. */
  readonly offered: boolean;
  /** The Document as this device last saved it, or null while it has never been saved. */
  readonly saved: PersonalDocument | null;
  /** How the last save went. */
  readonly saving: PersonalSaving;
  /** Shows new values, and saves them once typing has paused. */
  update(values: PersonalValues): void;
  /**
   * Deletes the Document from this device, dropping any save still waiting first.
   *
   * @throws {Error} when it couldn't be deleted; saving resumes, with what was typed.
   */
  remove(): Promise<void>;
}

/** What the editor shows once the device's Documents are read. */
interface Shown {
  readonly values: PersonalValues;
  readonly offered: boolean;
  readonly saved: PersonalDocument | null;
}

/** Where the editor starts: the stored Document, or else a new one, offered as the first. */
function shownFrom(documents: readonly PersonalDocument[], id: string): Shown {
  const stored = documents.find((document) => document.id === id);
  if (stored !== undefined) {
    return { values: { title: stored.title, text: stored.text }, offered: false, saved: stored };
  }
  const offered = documents.length === 0;
  const title = offered ? messages.personal.missionTitle : '';
  return { values: { title, text: '' }, offered, saved: null };
}

/**
 * The Document `values` make when saved at `at` over `before`: its title
 * trimmed, its text as typed, its first save's creation time, and a stamp
 * never earlier than the last one, even when the device clock goes back.
 */
function documentOf(
  id: string,
  values: PersonalValues,
  before: PersonalDocument | null,
  at: number,
): PersonalDocument {
  const createdAt = before?.createdAt ?? at;
  const updatedAt = Math.max(at, before?.updatedAt ?? at);
  return { id, title: values.title.trim(), text: values.text, createdAt, updatedAt };
}

/** The personal Document `id` in `documents`, edited and saved as typed, on the clock `now`. */
export function usePersonalDocument(
  documents: PersonalDocuments,
  id: string,
  now: () => number,
): PersonalEditor {
  const [shown, setShown] = useState<Shown | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [saving, setSaving] = useState<PersonalSaving>('none');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waiting = useRef<PersonalValues | null>(null);
  const latest = useRef<PersonalValues | null>(null);
  const before = useRef<PersonalDocument | null>(null);

  /** Saves `values` as the Document, unless its title isn't one to keep yet. */
  const keep = useCallback(
    (values: PersonalValues) => {
      if (!isPersonalTitle(values.title.trim())) {
        setSaving('held');
        return;
      }
      const document = documentOf(id, values, before.current, now());
      before.current = document;
      documents.savePersonal(document).then(
        () => {
          setSaving('saved');
          setShown((current) => (current === null ? current : { ...current, saved: document }));
        },
        () => {
          setSaving('failed');
        },
      );
    },
    [documents, id, now],
  );

  /** Cancels the timer and saves whatever was waiting for it. */
  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const values = waiting.current;
    waiting.current = null;
    if (values !== null) keep(values);
  }, [keep]);

  useEffect(() => {
    let live = true;
    documents.listPersonal().then(
      (list) => {
        if (!live) return;
        const start = shownFrom(list, id);
        before.current = start.saved;
        latest.current = start.values;
        setShown(start);
      },
      () => {
        if (live) setUnreadable(true);
      },
    );
    return () => {
      live = false;
      flush();
    };
  }, [documents, id, flush]);

  const update = (values: PersonalValues) => {
    setShown((current) => (current === null ? current : { ...current, values }));
    latest.current = values;
    waiting.current = values;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, DRAFT_SAVE_DELAY_MS);
  };

  const remove = async () => {
    // Nothing waits to be saved once Delete starts, so no later save brings the Document back.
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    waiting.current = null;
    try {
      await documents.deletePersonal(id);
    } catch (error) {
      if (latest.current !== null) keep(latest.current);
      throw error;
    }
  };

  return {
    values: shown?.values ?? null,
    unreadable,
    offered: shown?.offered ?? false,
    saved: shown?.saved ?? null,
    saving,
    update,
    remove,
  };
}
