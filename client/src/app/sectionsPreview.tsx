/**
 * A Document's first sections as they will read (spec §8): Create group's
 * Documents and a new Document's Proposal (#92) both split their text at
 * blank lines, so their Preview tabs and checks are the same.
 */
import type { ReactNode } from 'react';

import { genesisAtoms } from '../engine/atomText';
import { splitAtoms } from '../engine/text';
import { messages } from './messages';
import { AtomText } from './text/AtomText';

/** The sections as they will read: split at blank lines and normalized, each numbered. */
export function sectionsPreview(value: string): ReactNode {
  const sections = genesisAtoms(value);
  if (sections.length === 0) return null;
  return (
    <div className="document">
      {sections.map((section, index) => (
        // Sections are numbered by position, as the Document view numbers them.
        <div key={index} className="atom">
          <p className="eyebrow">{messages.composer.section(index + 1)}</p>
          <AtomText text={section} />
        </div>
      ))}
    </div>
  );
}

/** `missing` for text with no section in it, else null: no Document starts empty (#92). */
export function sectionsCheck(missing: string) {
  return (value: string): string | null => (splitAtoms(value).length === 0 ? missing : null);
}
