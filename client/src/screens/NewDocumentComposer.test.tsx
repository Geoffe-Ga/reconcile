import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ComposeOutcome } from '../app/compose';
import { againDraft, NEW_DOCUMENT_DRAFT, type ProposalValues } from '../app/proposals';
import { LEVELS } from '../engine/capabilities';
import type { GroupState, Proposal } from '../engine/fold';
import type { Draft } from '../store/drafts';
import { axeViolations } from '../test/axe';
import { memoryDrafts } from '../test/drafts';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { NewDocumentComposer } from './NewDocumentComposer';

type OnPropose = (values: ProposalValues) => Promise<ComposeOutcome>;

const [, VOTING] = LEVELS;

/** The device clock the voting time's closing line counts from: Wed 11 Nov 2026, noon UTC. */
const NOW = Date.UTC(2026, 10, 11, 12);
const CHAT = 'https://chat.example.org/riverside';

const HINT =
  '**bold**, *italic*, # heading, - list, [link](https://…). End a line with \\ for a line break.';

const box = (name: string) => screen.getByRole('textbox', { name });

async function replace(user: UserEvent, label: string, value: string): Promise<void> {
  await user.clear(box(label));
  if (value === '') return;
  await user.click(box(label));
  await user.paste(value);
}

async function fill(user: UserEvent, entries: Readonly<Record<string, string>>): Promise<void> {
  for (const [label, value] of Object.entries(entries)) await replace(user, label, value);
}

interface Options {
  readonly state?: GroupState;
  readonly me?: string;
  readonly onPropose?: OnPropose;
  readonly drafts?: Readonly<Record<string, Draft>>;
  readonly again?: Proposal;
  readonly leaving?: boolean;
}

/** Renders Propose a new Document and waits for its heading. */
async function compose(options: Options = {}) {
  const state = options.state ?? groupLog({ chat: CHAT }).state();
  const onPropose = vi.fn<OnPropose>(options.onPropose ?? (() => Promise.resolve('proposed')));
  const memory = memoryDrafts(options.drafts);
  render(
    <NewDocumentComposer
      state={state}
      me={options.me ?? authorOf('ana')}
      drafts={memory.drafts}
      now={NOW}
      onPropose={onPropose}
      leaving={options.leaving ?? false}
      {...(options.again === undefined ? {} : { again: options.again })}
    />,
  );
  await screen.findByRole('heading', { level: 1 });
  return { user: userEvent.setup(), state, onPropose, memory };
}

const ENTRIES = {
  Title: ' Start a budget ',
  Why: 'We spend together.',
  'Document title': ' Budget ',
  'First sections': '# Budget\n\nWe share costs.',
};

describe('NewDocumentComposer (#92)', () => {
  it('asks for a title, why, the Document’s title, its first sections and a discussion link', async () => {
    const { state } = await compose();
    expect(screen.getByRole('heading', { level: 1, name: 'Propose a new Document' })).toBeVisible();
    expect(document.title).toBe('Propose a new Document · Reconcile');
    expect(
      screen.getByText(
        'If your group passes it, your group has a new Document, listed after the others. What you write here becomes its first sections.',
      ),
    ).toBeVisible();
    const order = screen.getAllByRole('textbox').map((field) => field.getAttribute('name'));
    expect(order.slice(0, 5)).toEqual(['title', 'why', 'documentTitle', 'text', 'link']);
    for (const label of ['Title', 'Why', 'Document title', 'First sections']) {
      expect(box(label)).toBeRequired();
      expect(box(label)).toHaveValue('');
    }
    expect(box('Document title')).toHaveAccessibleDescription('For example, Budget or Chores.');
    expect(box('First sections')).toHaveAccessibleDescription(
      `Leave a blank line between sections. ${HINT}`,
    );
    expect(box('Discussion link (optional)')).toHaveValue(CHAT);
    expect(screen.getByRole('link', { name: 'Riverside Tenants' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}`,
    );
    expect(screen.getByRole('button', { name: 'Propose this Document' })).toBeEnabled();
    expect(await axeViolations()).toEqual([]);
  });

  it('hands over a new Document, its title trimmed into the target and its text as typed', async () => {
    const { user, onPropose } = await compose();
    await fill(user, { ...ENTRIES, 'Discussion link (optional)': '' });
    await user.click(screen.getByRole('button', { name: 'Propose this Document' }));
    expect(onPropose).toHaveBeenCalledWith({
      target: { kind: 'new-document', title: 'Budget' },
      title: 'Start a budget',
      why: 'We spend together.',
      text: '# Budget\n\nWe share costs.',
      link: null,
      window: 7,
    });
  });

  it('previews each section as it will read, numbered', async () => {
    const { user } = await compose();
    await fill(user, ENTRIES);
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('Section 1')).toBeVisible();
    expect(within(panel).getByRole('heading', { name: 'Budget' })).toBeVisible();
    expect(within(panel).getByText('Section 2')).toBeVisible();
    expect(within(panel).getByText('We share costs.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('refuses a blank Document title, one over 120 characters, and blank sections, each tied to its field', async () => {
    const { user, onPropose } = await compose();
    await fill(user, { ...ENTRIES, 'Document title': '   ', 'First sections': ' \n\n ' });
    await user.click(screen.getByRole('button', { name: 'Propose this Document' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(box('Document title')).toHaveAccessibleDescription(
      'For example, Budget or Chores. Give the new Document a title.',
    );
    expect(box('First sections')).toHaveAccessibleDescription(
      `Leave a blank line between sections. Write at least one section. ${HINT}`,
    );
    await replace(user, 'Document title', '\u{1d11e}'.repeat(121));
    await user.click(screen.getByRole('button', { name: 'Propose this Document' }));
    expect(box('Document title')).toHaveAccessibleDescription(
      'For example, Budget or Chores. Keep the Document title to 120 characters or fewer.',
    );
    await replace(user, 'Document title', '\u{1d11e}'.repeat(120));
    await replace(user, 'First sections', 'We share costs.');
    await user.click(screen.getByRole('button', { name: 'Propose this Document' }));
    expect(onPropose).toHaveBeenCalledTimes(1);
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps its draft, the Document’s title included, under the group’s new-document key', async () => {
    const draft = {
      title: 'Budget',
      why: 'Money.',
      text: 'We share.',
      link: '',
      documentTitle: 'Money',
    };
    const { memory } = await compose({ drafts: { [NEW_DOCUMENT_DRAFT]: draft } });
    expect(box('Document title')).toHaveValue('Money');
    expect(box('First sections')).toHaveValue('We share.');
    expect(screen.getByText('Your draft is back. It’s saved on this device only.')).toBeVisible();
    const user = userEvent.setup();
    await replace(user, 'Document title', 'Shared money');
    await waitFor(() => {
      expect(memory.shelf.get(NEW_DOCUMENT_DRAFT)?.documentTitle).toBe('Shared money');
    });
  });

  it('starts a carried Dispatch’s title from the new Document’s title (#112)', async () => {
    const { user, onPropose } = await compose();
    await fill(user, ENTRIES);
    await user.click(screen.getByRole('checkbox', { name: 'Send a Dispatch if this passes' }));
    expect(box('Dispatch title')).toHaveValue('New Document: Budget');
    await user.click(screen.getByRole('button', { name: 'Propose this Document' }));
    expect(onPropose.mock.calls[0]?.[0].dispatch).toEqual({
      title: 'New Document: Budget',
      text: '',
    });
  });

  it('proposes a lapsed new Document again from its title, words and other versions (#74)', async () => {
    const log = groupLog({ chat: CHAT });
    const lapsedId = log.newDocument('Ana', 'Budget', { text: 'We share costs.\n' });
    log.version('Ben', lapsedId, 'We split costs.\n');
    const state = log.state(deadlineOf(START_MINUTE));
    const again = state.proposals.find((p) => p.id === lapsedId);
    if (again === undefined) throw new Error('Expected the Proposal.');
    const { user, onPropose, memory } = await compose({ state, again });
    expect(screen.getByRole('heading', { level: 1, name: 'Propose again' })).toBeVisible();
    expect(box('Document title')).toHaveValue('Budget');
    expect(box('First sections')).toHaveValue('We share costs.\n');
    await user.click(screen.getByRole('button', { name: 'Propose this Document' }));
    expect(onPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'new-document', title: 'Budget' },
        again: lapsedId,
        versions: ['We split costs.\n'],
      }),
    );
    expect(memory.drafts.load).toHaveBeenCalledWith(againDraft(lapsedId));
  });

  it('offers no form to someone who may not propose, or while their leave waits', async () => {
    const log = groupLog({ members: ['Ben'], levels: { Ben: VOTING } });
    await compose({ state: log.state(), me: authorOf('ben') });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You can’t propose changes here' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});
