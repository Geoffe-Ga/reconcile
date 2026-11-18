/**
 * Settings › Steward key (#488; docs/spec/listed-doors.md §6.2): quiet, for
 * the platform steward's one device (ADR-0018). It takes the secret
 * `scripts/steward_key.py` printed as a password, so no browser keeps it in
 * an autofill history, and the store keeps it through `keepKeys`, sealed in
 * the passkey vault where there is one. Once held, one line says so and links
 * to the console.
 */
import { type SyntheticEvent, useState } from 'react';
import { Button, Form, Link } from 'react-aria-components';

import { holdPresses } from './holdPresses';
import { messages } from './messages';
import { routeHref } from './router';
import { Field } from './ui';

/** How an import ended: kept, not the pinned steward's, refused while locked, or not kept. */
export type StewardImport = 'imported' | 'wrong' | 'locked' | 'failed';

/** What Settings' steward section shows and does. */
export interface StewardSettings {
  /** Whether this device holds the steward's key. */
  readonly held: boolean;
  /** Imports the secret `text` spells, when it derives the pinned keys. */
  readonly onImport: (text: string) => Promise<StewardImport>;
}

/** The import's state: idle, busy, or why the last one didn't take. */
type Note = 'idle' | 'importing' | Exclude<StewardImport, 'imported'>;

/** The steward key section: the import, or that this device holds it. */
export function StewardKeyCard({ steward }: { readonly steward: StewardSettings }) {
  const words = messages.shelfSteward;
  const [text, setText] = useState('');
  const [note, setNote] = useState<Note>('idle');
  const busy = note === 'importing';
  if (steward.held) {
    return (
      <div className="stack">
        <p className="lede">{words.held}</p>
        <div>
          <Link className="button button-secondary" href={routeHref({ name: 'console' })}>
            {words.open}
          </Link>
        </div>
      </div>
    );
  }
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || text.trim() === '') return;
    setNote('importing');
    void steward
      .onImport(text)
      .catch((): StewardImport => 'failed')
      .then((outcome) => {
        setNote(outcome === 'imported' ? 'idle' : outcome);
        if (outcome === 'imported') setText('');
      });
  };
  return (
    <Form className="form" onSubmit={submit}>
      <p className="lede">{words.keyLede}</p>
      <Field
        name="steward-secret"
        type="password"
        autoComplete="off"
        label={words.label}
        value={text}
        onChange={setText}
      />
      <div onPointerDownCapture={holdPresses(busy)}>
        <Button type="submit" className="button button-secondary" isDisabled={busy}>
          {busy ? words.importing : words.import}
        </Button>
      </div>
      <p className="status" role="status">
        {note === 'idle' || note === 'importing' ? null : words[note]}
      </p>
    </Form>
  );
}
