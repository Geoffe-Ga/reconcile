import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  atomsOf,
  DOCUMENT_TITLE_MAX,
  documentOf,
  documentSections,
  documentTitle,
  documentTitleFits,
  type ProposedChange,
} from './documents';
import type { ProposalTarget } from './stewards';
import { splitAtoms } from './text';

/** A group with two founded Documents, one new one, and an added section in the second. */
const STATE = {
  documents: [
    { id: 'G', title: 'Mission statement' },
    { id: 'G:1', title: 'House rules' },
    { id: 'N', title: 'Budget' },
  ],
  atoms: [
    { id: 'G.0', documentId: 'G', text: 'We share.\n' },
    { id: 'G:1.0', documentId: 'G:1', text: 'Quiet after 11pm.\n' },
    { id: 'A', documentId: 'G:1', text: 'Guests leave by 11pm.\n' },
    { id: 'N.0', documentId: 'N', text: 'We keep a budget.\n' },
  ],
  proposals: [
    { id: 'A', atom: 'A', target: { kind: 'add', document: 'G:1', after: 'G:1.0' } as const },
    { id: 'R', atom: 'R', target: { kind: 'add', document: 'G:1', after: null } as const },
  ],
};

/** A Proposal with `target` on `atom`, as the fold keeps one. */
function change(id: string, atom: string, target: ProposalTarget): ProposedChange {
  return { id, atom, target };
}

describe('documentTitleFits (#92)', () => {
  it.each([
    ['a word', 'Budget', true],
    ['120 code points, each two UTF-16 units', '\u{1d11e}'.repeat(DOCUMENT_TITLE_MAX), true],
    ['121 code points', '\u{1d11e}'.repeat(DOCUMENT_TITLE_MAX + 1), false],
    ['121 plain letters', 'x'.repeat(121), false],
    ['empty', '', false],
    ['spaces alone', '   ', false],
    ['a tab and a newline alone', '\t\n', false],
  ])('takes %s: %s', (_label, title, fits) => {
    expect(documentTitleFits(title)).toBe(fits);
  });

  it('is 120 code points at most', () => {
    expect(DOCUMENT_TITLE_MAX).toBe(120);
  });
});

describe('documentSections (#92)', () => {
  it('splits the text at blank lines, each section ending in one newline', () => {
    expect(documentSections('# Budget\n\nWe share costs.\n')).toEqual([
      '# Budget\n',
      'We share costs.\n',
    ]);
  });

  it('keeps lines together within a section, and drops runs of blank lines', () => {
    expect(documentSections('One\nstill one\n\n\n\nTwo\n')).toEqual(['One\nstill one\n', 'Two\n']);
  });

  it.each([[''], ['\n'], ['  \n\n\t\n']])('gives no sections for blank text %j', (text) => {
    expect(documentSections(text)).toEqual([]);
  });

  it('gives one section per splitAtoms part, whatever the text', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const sections = documentSections(text);
        expect(sections).toEqual(splitAtoms(text).map((part) => `${part}\n`));
        expect(sections.every((section) => section.endsWith('\n'))).toBe(true);
      }),
    );
  });
});

describe('documentOf (#92)', () => {
  it('names the Document of the section a change rewords', () => {
    expect(documentOf(STATE, change('P', 'G:1.0', { kind: 'edit' }))).toBe('G:1');
    expect(documentOf(STATE, change('P', 'N.0', { kind: 'edit' }))).toBe('N');
    expect(documentOf(STATE, change('P', 'A', { kind: 'edit' }))).toBe('G:1');
  });

  it("names a removed section's Document from its id, or from the add that made it", () => {
    expect(documentOf(STATE, change('P', 'G.1', { kind: 'edit' }))).toBe('G');
    expect(documentOf(STATE, change('P', 'G:1.4', { kind: 'edit' }))).toBe('G:1');
    expect(documentOf(STATE, change('P', 'N.3', { kind: 'edit' }))).toBe('N');
    expect(documentOf(STATE, change('P', 'R', { kind: 'edit' }))).toBe('G:1');
  });

  it('names the Document of the section a move moves, even once a removal has taken it out (#103)', () => {
    expect(
      documentOf(STATE, change('P', 'G:1.0', { kind: 'move', atom: 'G:1.0', after: null })),
    ).toBe('G:1');
    expect(documentOf(STATE, change('P', 'G.1', { kind: 'move', atom: 'G.1', after: 'G.0' }))).toBe(
      'G',
    );
  });

  it('names nothing for a section it has no trace of', () => {
    expect(documentOf(STATE, change('P', 'nowhere', { kind: 'edit' }))).toBeNull();
  });

  it('names the Document an add puts its section in, and a new Document by its own id', () => {
    const add = change('P', 'P', { kind: 'add', document: 'N', after: null });
    expect(documentOf(STATE, add)).toBe('N');
    const created = change('Q', 'Q', { kind: 'new-document', title: 'Garden' });
    expect(documentOf(STATE, created)).toBe('Q');
  });

  it('names none for a Proposal that changes no Document', () => {
    const target = { kind: 'dissolve', wipe: false } as const;
    expect(documentOf(STATE, change('P', '', target))).toBeNull();
  });

  it('names none for a priority vote, whose own-id atom is no section (#107)', () => {
    expect(documentOf(STATE, change('Q', 'Q', { kind: 'priority' }))).toBeNull();
  });
});

describe('atomsOf and documentTitle (#92)', () => {
  it("lists one Document's sections in order", () => {
    expect(atomsOf(STATE, 'G:1').map((atom) => atom.id)).toEqual(['G:1.0', 'A']);
    expect(atomsOf(STATE, 'missing')).toEqual([]);
  });

  it("gives a Document's title, or null for one the group doesn't have", () => {
    expect(documentTitle(STATE, 'N')).toBe('Budget');
    expect(documentTitle(STATE, 'G.0')).toBeNull();
    expect(documentTitle(STATE, null)).toBeNull();
  });
});
