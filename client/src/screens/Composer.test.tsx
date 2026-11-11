import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGroup } from '../app/actions';
import {
  addVersion,
  againDraft,
  propose,
  type ProposalValues,
  type VersionValues,
} from '../app/proposals';
import { fold, type GroupState, type Proposal } from '../engine/fold';
import type { Draft, GroupDrafts } from '../store/drafts';
import { groupDrafts } from '../store/drafts';
import { testDevice, type TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { memoryDrafts } from '../test/drafts';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { authorOf } from '../test/keys';
import { Composer, type ComposeOutcome } from './Composer';

freshIndexedDBPerTest();

type OnPropose = (values: ProposalValues) => Promise<ComposeOutcome>;
type OnAddVersion = (values: VersionValues) => Promise<ComposeOutcome>;

/** The device clock the voting time's closing line counts from: Wed 11 Nov 2026, noon UTC. */
const NOW = Date.UTC(2026, 10, 11, 12);

const HINT =
  '**bold**, *italic*, # heading, - list, [link](https://…). End a line with \\ for a line break.';

interface Setup {
  readonly state?: GroupState;
  readonly atom?: number;
  readonly me?: string;
  readonly onPropose?: OnPropose;
  readonly onAddVersion?: OnAddVersion;
  readonly drafts?: GroupDrafts;
  /** The Proposal being proposed again, from the `again` route. */
  readonly again?: Proposal;
  /** Whether this device's leave waits for the relay (#77). */
  readonly leaving?: boolean;
}

/** Renders the composer and waits for its draft to be read. */
async function setup(options: Setup = {}) {
  const { state, atom = 0, me = authorOf('ana'), onPropose, onAddVersion, drafts, again } = options;
  const { leaving } = options;
  const group = state ?? groupLog({ chat: 'https://chat.example.org/riverside' }).state();
  const propose = vi.fn<OnPropose>(onPropose ?? (() => Promise.resolve('proposed')));
  const add = vi.fn<OnAddVersion>(onAddVersion ?? (() => Promise.resolve('added')));
  const memory = memoryDrafts();
  const atomId = `${group.group ?? ''}.${String(atom)}`;
  const view = render(
    <Composer
      state={group}
      me={me}
      atomId={atomId}
      drafts={drafts ?? memory.drafts}
      now={NOW}
      onPropose={propose}
      onAddVersion={add}
      {...(again === undefined ? {} : { again })}
      leaving={leaving === true}
    />,
  );
  await screen.findByRole('heading', { level: 1 });
  return {
    user: userEvent.setup(),
    onPropose: propose,
    onAddVersion: add,
    state: group,
    atomId,
    memory,
    view,
  };
}

const box = (name: string) => screen.getByRole('textbox', { name });
const submit = () => screen.getByRole('button', { name: 'Propose this change' });

async function replace(user: UserEvent, label: string, value: string): Promise<void> {
  await user.clear(box(label));
  if (value === '') return;
  await user.click(box(label));
  await user.paste(value);
}

async function fill(user: UserEvent, entries: Readonly<Record<string, string>>): Promise<void> {
  for (const [label, value] of Object.entries(entries)) await replace(user, label, value);
}

describe('Composer', () => {
  it('shows the section as it reads now, and four fields, prefilled', async () => {
    const { state } = await setup({ atom: 1 });

    expect(screen.getByRole('heading', { level: 1, name: 'Propose a change' })).toBeVisible();
    const now = screen.getByRole('region', { name: 'Section 2 now reads' });
    expect(now).toHaveTextContent('Bins go out on Tuesday.');
    expect(box('Title')).toHaveValue('');
    expect(box('Title')).toBeRequired();
    expect(box('Why')).toBeRequired();
    expect(box('Why').tagName).toBe('TEXTAREA');
    expect(box('New text')).toHaveValue('Bins go out on Tuesday.');
    expect(box('New text')).toHaveClass('input-document');
    expect(box('Discussion link (optional)')).toHaveValue('https://chat.example.org/riverside');
    expect(box('Discussion link (optional)')).not.toBeRequired();
    for (const label of ['Title', 'Why', 'New text']) {
      expect(box(label)).not.toHaveAttribute('maxlength');
    }
    expect(
      screen.getByText(
        'Your draft stays on this device until you propose it. Then everyone in your group sees this Proposal and that you made it.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'House rules' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/doc/${state.group ?? ''}`,
    );
    expect(document.title).toBe('Propose a change · Reconcile');
    expect(await axeViolations()).toEqual([]);
  });

  it('sets the section as it reads now through the Markdown renderer', async () => {
    const log = groupLog({ atoms: ['Quiet *after* ten.\n', 'Bins.\n'] });
    await setup({ state: log.state() });
    const now = screen.getByRole('region', { name: 'Section 1 now reads' });
    expect(within(now).getByText('after', { selector: 'em' })).toBeVisible();
  });

  it('writes the new text in Write and Preview tabs, with one Markdown hint line', async () => {
    const { user } = await setup();
    expect(screen.getByRole('tab', { name: 'Write' })).toHaveAttribute('aria-selected', 'true');
    expect(box('New text')).toHaveAccessibleDescription(
      `If your group passes it, this replaces the section. ${HINT}`,
    );
    await replace(user, 'New text', '# Quiet\r\n\r\nAfter **11pm**.  ');
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    const preview = screen.getByRole('tabpanel', { name: 'Preview' });
    expect(within(preview).getByRole('heading', { level: 2, name: 'Quiet' })).toBeVisible();
    expect(within(preview).getByText('11pm', { selector: 'strong' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('prefills the link of the latest Proposal that carries one', async () => {
    const atoms = ['Quiet hours start at ten.', 'Bins go out on Tuesday.', 'Guests welcome.'];
    const log = groupLog({ chat: 'https://chat.example.org/riverside', atoms });
    log.propose('ana', { link: 'https://chat.example.org/quiet-hours' });
    log.propose('ben', { atom: 1 });
    await setup({ state: log.state(), atom: 2 });
    expect(box('Discussion link (optional)')).toHaveValue('https://chat.example.org/quiet-hours');
  });

  it('hands over the entries, trimmed, with a blank link as none', async () => {
    const { user, onPropose, state } = await setup();
    await fill(user, {
      Title: '  Later quiet hours ',
      Why: ' Weekends run late. ',
      'New text': 'Quiet after 11pm.\n',
      'Discussion link (optional)': '   ',
    });
    await user.click(submit());
    expect(onPropose).toHaveBeenCalledWith({
      atom: `${state.group ?? ''}.0`,
      title: 'Later quiet hours',
      why: 'Weekends run late.',
      text: 'Quiet after 11pm.\n',
      link: null,
      window: 7,
    });
  });

  it('keeps a discussion link, trimmed', async () => {
    const { user, onPropose } = await setup();
    await fill(user, { Title: 'Later', Why: 'Weekends.', 'New text': 'Quiet after 11pm.' });
    await replace(user, 'Discussion link (optional)', ' https://chat.example.org/later ');
    await user.click(submit());
    expect(onPropose.mock.calls[0]?.[0].link).toBe('https://chat.example.org/later');
  });

  it('refuses a javascript: link, with the reason tied to the field', async () => {
    const { user, onPropose } = await setup();
    await fill(user, { Title: 'Later', Why: 'Weekends.', 'New text': 'Quiet after 11pm.' });
    await replace(user, 'Discussion link (optional)', 'javascript:alert(1)');
    await user.click(submit());

    expect(onPropose).not.toHaveBeenCalled();
    const link = box('Discussion link (optional)');
    expect(link).toHaveAttribute('aria-invalid', 'true');
    const error = screen.getByText('Use a web link that starts with https:// or http://.');
    expect(link.getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
    expect(await axeViolations()).toEqual([]);
  });

  it('names every missing entry, and sends nothing', async () => {
    const { user, onPropose } = await setup();
    await replace(user, 'New text', ' \n ');
    await user.click(submit());

    expect(onPropose).not.toHaveBeenCalled();
    expect(box('Title')).toHaveAccessibleDescription(
      'A few words that say what changes. Give your Proposal a title.',
    );
    expect(box('Why')).toHaveAccessibleDescription(
      'Tell your group what this fixes or makes better. Say why you’re proposing this.',
    );
    expect(box('New text')).toHaveAccessibleDescription(
      `If your group passes it, this replaces the section. Write the new text for this section. ${HINT}`,
    );
    expect(box('Title')).toHaveFocus();
  });

  it.each([
    ['unchanged', (text: string) => text],
    ['but for CRLF line endings', (text: string) => text.replace(/\n/g, '\r\n')],
    ['but for trailing spaces and newlines', (text: string) => `${text}  \n\n`],
    ['but for NFD', (text: string) => text.normalize('NFD')],
  ])('refuses text that reads the same as the section now, %s', async (_name, change) => {
    const log = groupLog({ atoms: ['Café hours start at ten.\n'] });
    const { user, onPropose } = await setup({ state: log.state() });
    await fill(user, { Title: 'Later', Why: 'Weekends.' });
    await replace(user, 'New text', change('Café hours start at ten.\n'));
    await user.click(submit());

    expect(onPropose).not.toHaveBeenCalled();
    expect(box('New text')).toHaveAttribute('aria-invalid', 'true');
    expect(box('New text')).toHaveAccessibleDescription(
      `If your group passes it, this replaces the section. This reads the same as the section does now. Change it to propose something new. ${HINT}`,
    );
  });

  it('counts the title and why in code points after NFC, not UTF-16 units', async () => {
    const { user, onPropose } = await setup();
    // "é" as e + combining accent: two code points each, one after NFC.
    await fill(user, {
      Title: 'é'.repeat(120),
      Why: '😀'.repeat(2000),
      'New text': 'Quiet after 11pm.',
    });
    await user.click(submit());
    expect(onPropose).toHaveBeenCalledTimes(1);

    await fill(user, { Title: 'é'.repeat(121), Why: '😀'.repeat(2001) });
    await user.click(submit());
    expect(onPropose).toHaveBeenCalledTimes(1);
    expect(box('Title')).toHaveAccessibleDescription(
      'A few words that say what changes. Keep the title to 120 characters or fewer.',
    );
    expect(box('Why')).toHaveAccessibleDescription(
      'Tell your group what this fixes or makes better. Keep it to 2,000 characters or fewer.',
    );
  });

  it('ties a too-large Proposal to its text', async () => {
    const onPropose = vi.fn<OnPropose>(() => Promise.resolve('too-large'));
    const { user } = await setup({ onPropose });
    await fill(user, { Title: 'Later', Why: 'Weekends.', 'New text': 'Quiet after 11pm.' });
    await user.click(submit());
    expect(box('New text')).toHaveAttribute('aria-invalid', 'true');
    expect(box('New text')).toHaveAccessibleDescription(
      `If your group passes it, this replaces the section. This is too long to send. Shorten it, then try again. ${HINT}`,
    );
  });

  it('keeps only the latest submit’s refusal', async () => {
    const outcomes: ComposeOutcome[] = ['too-large', 'failed'];
    const onPropose = vi.fn<OnPropose>(() => Promise.resolve(outcomes.shift() ?? 'failed'));
    const { user } = await setup({ onPropose });
    await fill(user, { Title: 'Later', Why: 'Weekends.', 'New text': 'Quiet after 11pm.' });
    await user.click(submit());
    expect(box('New text')).toHaveAttribute('aria-invalid', 'true');
    await replace(user, 'New text', 'Quiet after midnight.');
    await user.click(submit());
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(box('New text')).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('This is too long to send. Shorten it, then try again.')).toBeNull();
  });

  it('says so when the Proposal couldn’t be saved', async () => {
    const onPropose = vi.fn<OnPropose>(() => Promise.reject(new Error('quota')));
    const { user } = await setup({ onPropose });
    await fill(user, { Title: 'Later', Why: 'Weekends.', 'New text': 'Quiet after 11pm.' });
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your Proposal couldn’t be saved on this device. Try again.',
    );
    expect(submit()).toBeEnabled();
  });

  it('keeps the button disabled while it proposes, and proposes once', async () => {
    let finish: (outcome: ComposeOutcome) => void = () => undefined;
    const onPropose = vi.fn<OnPropose>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = await setup({ onPropose });
    await fill(user, { Title: 'Later', Why: 'Weekends.', 'New text': 'Quiet after 11pm.' });
    await user.click(submit());
    expect(submit()).toBeDisabled();
    await user.click(submit());
    finish('proposed');
    await Promise.resolve();
    expect(submit()).toBeDisabled();
    expect(onPropose).toHaveBeenCalledTimes(1);
  });

  it('says when the section isn’t in the Document', async () => {
    const state = groupLog().state();
    const { drafts } = memoryDrafts();
    render(
      <Composer
        state={state}
        me={authorOf('ana')}
        atomId="missing.0"
        drafts={drafts}
        now={NOW}
        onPropose={vi.fn()}
        onAddVersion={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section isn’t in the Document' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(drafts.load).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no composer to someone whose leave waits for the relay', async () => {
    await setup({ leaving: true });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You’re leaving this group' }),
    ).toBeVisible();
    expect(screen.getByText('You can’t propose changes in a group you’re leaving.')).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no composer to someone who may not propose', async () => {
    await setup({ me: 'stranger' });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You can’t propose changes here' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

/** Ana's open Proposal on section 1 of Ana and Ben's group, with any further versions. */
function busy(...versions: readonly string[]) {
  const log = groupLog({ chat: 'https://chat.example.org/riverside' });
  const proposal = log.propose('ana', { title: 'Later quiet hours', text: 'Quiet after 11pm.\n' });
  for (const text of versions) log.version('ben', proposal, text);
  return { state: log.state(), proposal };
}

const addSubmit = () => screen.getByRole('button', { name: 'Add your version' });

describe('Composer, adding a version', () => {
  it('becomes “Add your version” on a busy section: the text alone, prefilled with the section', async () => {
    const { state, proposal } = busy();
    await setup({ state });
    expect(screen.getByRole('heading', { level: 1, name: 'Add your version' })).toBeVisible();
    expect(document.title).toBe('Add your version · Reconcile');
    expect(
      screen.getByText(
        'This section already has an open Proposal. Your wording goes on its ballot beside the others, and everyone scores each version.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'Section 1 now reads' })).toHaveTextContent(
      'Quiet hours start at ten.',
    );
    expect(box('Your version')).toHaveValue('Quiet hours start at ten.');
    expect(box('Your version')).toBeRequired();
    expect(box('Your version')).toHaveAccessibleDescription(
      `If your group passes it, this replaces the section. ${HINT}`,
    );
    for (const label of ['Title', 'Why', 'New text', 'Discussion link (optional)']) {
      expect(screen.queryByRole('textbox', { name: label })).not.toBeInTheDocument();
    }
    expect(
      screen.getByText(
        'Your draft stays on this device until you add it. Then everyone in your group sees your version and that you wrote it.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Later quiet hours' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/p/${proposal}`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('hands over the version for the open Proposal, as typed', async () => {
    const { state, proposal } = busy();
    const { user, onAddVersion, onPropose } = await setup({ state });
    await replace(user, 'Your version', 'Quiet after midnight.');
    await user.click(addSubmit());
    expect(onAddVersion).toHaveBeenCalledWith({ proposal, text: 'Quiet after midnight.' });
    expect(onPropose).not.toHaveBeenCalled();
    expect(addSubmit()).toBeDisabled();
  });

  it.each([
    ['blank text', '  \n', 'Write your version of this section.'],
    [
      'the section’s own text',
      'Quiet hours start at ten.  \n',
      'This reads the same as the section does now. Change it to propose something new.',
    ],
    [
      'the Proposal’s own version',
      'Quiet after 11pm.',
      'This reads the same as a version already on the ballot. Change it to add something new.',
    ],
    [
      'a version added since',
      'Quiet after midnight.\r\n',
      'This reads the same as a version already on the ballot. Change it to add something new.',
    ],
  ])('blocks %s, with the reason tied to the field', async (_label, text, reason) => {
    const { state } = busy('Quiet after midnight.\n');
    const { user, onAddVersion } = await setup({ state });
    await replace(user, 'Your version', text);
    await user.click(addSubmit());
    expect(onAddVersion).not.toHaveBeenCalled();
    expect(box('Your version')).toHaveAttribute('aria-invalid', 'true');
    expect(box('Your version')).toHaveAccessibleDescription(
      `If your group passes it, this replaces the section. ${reason} ${HINT}`,
    );
  });

  it('ties a too-large version to its text, and says so when it couldn’t be saved', async () => {
    const outcomes: ComposeOutcome[] = ['too-large'];
    const onAddVersion = vi.fn<OnAddVersion>(() =>
      outcomes.length > 0
        ? Promise.resolve(outcomes.shift() ?? 'failed')
        : Promise.reject(new Error('quota')),
    );
    const { state } = busy();
    const { user } = await setup({ state, onAddVersion });
    await replace(user, 'Your version', 'Quiet after midnight.');
    await user.click(addSubmit());
    expect(box('Your version')).toHaveAccessibleDescription(
      `If your group passes it, this replaces the section. This is too long to send. Shorten it, then try again. ${HINT}`,
    );
    await replace(user, 'Your version', 'Quiet after half past eleven.');
    await user.click(addSubmit());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your version couldn’t be saved on this device. Try again.',
    );
    expect(addSubmit()).toBeEnabled();
  });

  it('says the ballot is full once it holds three versions, with no form', async () => {
    const { state } = busy('Quiet after midnight.\n', 'Quiet after 10pm.\n');
    const { memory } = await setup({ state });
    expect(screen.getByRole('heading', { level: 1, name: 'This ballot is full' })).toBeVisible();
    expect(screen.getByText('This ballot already has three versions.')).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(memory.drafts.load).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps the version’s draft under its Proposal, apart from the section’s own draft', async () => {
    const { state, proposal } = busy();
    const atomDraft = { title: 'Mine', why: 'Mine.', text: 'Quiet after 9pm.', link: '' };
    const memory = memoryDrafts({ [`${state.group ?? ''}.0`]: atomDraft });
    const { user } = await setup({ state, drafts: memory.drafts });
    expect(box('Your version')).toHaveValue('Quiet hours start at ten.');
    await replace(user, 'Your version', 'Quiet after midnight.');
    await waitFor(() => {
      expect(memory.shelf.get(proposal)).toEqual({
        title: '',
        why: '',
        text: 'Quiet after midnight.',
        link: '',
      });
    });
    expect(memory.shelf.get(`${state.group ?? ''}.0`)).toEqual(atomDraft);
    expect(memory.drafts.load).toHaveBeenCalledWith(proposal);
  });
});

describe('Composer, adding a version of a new section', () => {
  /** Ben's open add after section 1, and the composer on it. */
  async function onAdd() {
    const log = groupLog();
    const add = log.addSection('ben', `${log.group}.0`, {
      title: 'Guests',
      text: 'Guests leave by 11pm.\n',
    });
    const state = log.state();
    const onAddVersion = vi.fn<OnAddVersion>(() => Promise.resolve('added'));
    const memory = memoryDrafts();
    render(
      <Composer
        state={state}
        me={authorOf('ana')}
        atomId={add}
        drafts={memory.drafts}
        now={NOW}
        onPropose={vi.fn()}
        onAddVersion={onAddVersion}
      />,
    );
    await screen.findByRole('heading', { level: 1 });
    return { user: userEvent.setup(), state, add, onAddVersion, memory };
  }

  it('says where the section goes, and starts from the add’s own text', async () => {
    const { state, add, memory } = await onAdd();
    expect(screen.getByRole('heading', { level: 1, name: 'Add your version' })).toBeVisible();
    expect(
      screen.getByText(
        'This new section has an open Proposal. Your wording goes on its ballot beside the others, and everyone scores each version.',
      ),
    ).toBeVisible();
    expect(screen.getByText('Adds a section after ‘Quiet hours start at ten.’')).toBeVisible();
    expect(screen.queryByRole('region', { name: /now reads$/ })).not.toBeInTheDocument();
    expect(box('Your version')).toHaveValue('Guests leave by 11pm.\n');
    expect(box('Your version')).toHaveAccessibleDescription(
      `If your group passes it, this becomes the new section. ${HINT}`,
    );
    expect(screen.getByRole('link', { name: 'Guests' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/p/${add}`,
    );
    expect(memory.drafts.load).toHaveBeenCalledWith(add);
    expect(await axeViolations()).toEqual([]);
  });

  it('hands over the version for the add', async () => {
    const { user, add, onAddVersion } = await onAdd();
    await replace(user, 'Your version', 'Guests leave by midnight.');
    await user.click(addSubmit());
    expect(onAddVersion).toHaveBeenCalledWith({ proposal: add, text: 'Guests leave by midnight.' });
  });

  it.each([
    ['blank text', ' \n', 'Write the new section.'],
    [
      'the add’s own text',
      'Guests leave by 11pm.',
      'This reads the same as a version already on the ballot. Change it to add something new.',
    ],
  ])('blocks %s, with the reason tied to the field', async (_label, text, reason) => {
    const { user, onAddVersion } = await onAdd();
    await replace(user, 'Your version', text);
    await user.click(addSubmit());
    expect(onAddVersion).not.toHaveBeenCalled();
    expect(box('Your version')).toHaveAccessibleDescription(
      `If your group passes it, this becomes the new section. ${reason} ${HINT}`,
    );
  });
});

describe('Composer, adding a version of a new Document (#92)', () => {
  /** Ben's open new Document, and the composer on it. */
  async function onNewDocument() {
    const log = groupLog();
    const created = log.newDocument('ben', 'Budget', {
      title: 'Start a budget',
      text: '# Budget\n\nWe share costs.\n',
    });
    const state = log.state();
    const onAddVersion = vi.fn<OnAddVersion>(() => Promise.resolve('added'));
    const memory = memoryDrafts();
    render(
      <Composer
        state={state}
        me={authorOf('ana')}
        atomId={created}
        drafts={memory.drafts}
        now={NOW}
        onPropose={vi.fn()}
        onAddVersion={onAddVersion}
      />,
    );
    await screen.findByRole('heading', { level: 1 });
    return { user: userEvent.setup(), state, created, onAddVersion, memory };
  }

  it('names the new Document, and starts from its own first sections', async () => {
    const { state, created, memory } = await onNewDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Add your version' })).toBeVisible();
    expect(
      screen.getByText(
        'This new Document has an open Proposal. Your wording goes on its ballot beside the others, and everyone scores each version.',
      ),
    ).toBeVisible();
    expect(document.querySelector('.document-of')).toHaveTextContent('New Document: Budget');
    expect(box('Your version')).toHaveValue('# Budget\n\nWe share costs.\n');
    expect(box('Your version')).toHaveAccessibleDescription(
      `If your group passes it, these become the new Document’s first sections. Leave a blank line between sections. ${HINT}`,
    );
    expect(screen.getByRole('link', { name: 'Start a budget' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/p/${created}`,
    );
    expect(memory.drafts.load).toHaveBeenCalledWith(created);
    expect(await axeViolations()).toEqual([]);
  });

  it('hands over the version, and refuses blank text with its own reason', async () => {
    const { user, created, onAddVersion } = await onNewDocument();
    await replace(user, 'Your version', ' \n\n ');
    await user.click(addSubmit());
    expect(onAddVersion).not.toHaveBeenCalled();
    expect(box('Your version')).toHaveAccessibleDescription(
      `If your group passes it, these become the new Document’s first sections. Leave a blank line between sections. Write at least one section. ${HINT}`,
    );
    await replace(user, 'Your version', '# Budget\n\nWe split costs.');
    await user.click(addSubmit());
    expect(onAddVersion).toHaveBeenCalledWith({
      proposal: created,
      text: '# Budget\n\nWe split costs.',
    });
  });
});

describe('Composer, proposing again', () => {
  /** Ana proposes with a link, Ben adds a version, and nobody votes, so it lapses at its deadline. */
  function lapsed() {
    const log = groupLog({ chat: 'https://chat.example.org/riverside' });
    const proposalId = log.propose('ana', {
      title: 'Later quiet hours',
      why: 'Weekends run late.',
      text: 'Quiet after 11pm.\n',
      link: 'https://chat.example.org/later',
    });
    log.version('ben', proposalId, 'Quiet after midnight.\n');
    const state = log.state(deadlineOf(START_MINUTE));
    const again = state.proposals.find((proposal) => proposal.id === proposalId);
    if (again === undefined) throw new Error('Expected the Proposal.');
    return { state, again };
  }

  it('opens on the same section with the same title, why, link and versions', async () => {
    const { state, again } = lapsed();
    await setup({ state, again });
    expect(screen.getByRole('heading', { level: 1, name: 'Propose again' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Section 1 now reads' })).toHaveTextContent(
      'Quiet hours start at ten.',
    );
    expect(box('Title')).toHaveValue('Later quiet hours');
    expect(box('Why')).toHaveValue('Weekends run late.');
    expect(box('New text')).toHaveValue('Quiet after 11pm.\n');
    expect(box('Discussion link (optional)')).toHaveValue('https://chat.example.org/later');
    const others = screen.getByRole('region', { name: 'Also on the ballot' });
    expect(within(others).getByRole('region', { name: 'Version 2' })).toHaveTextContent(
      'Quiet after midnight.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('hands over the entries with the other versions’ texts and the Proposal it repeats', async () => {
    const { state, again } = lapsed();
    const { user, onPropose } = await setup({ state, again });
    await replace(user, 'Title', 'Quiet hours, again');
    await user.click(submit());
    expect(onPropose).toHaveBeenCalledWith({
      atom: again.atom,
      title: 'Quiet hours, again',
      why: 'Weekends run late.',
      text: 'Quiet after 11pm.\n',
      link: 'https://chat.example.org/later',
      window: 7,
      again: again.id,
      versions: ['Quiet after midnight.\n'],
    });
  });

  it('opens a lapsed 10-day Proposal with 10 days chosen, and proposes it again for 10 (#106)', async () => {
    const log = groupLog();
    const proposalId = log.propose('ana', { window: 10 });
    const state = log.state(START_MINUTE + 10 * 1_440);
    const again = state.proposals.find((proposal) => proposal.id === proposalId);
    if (again?.outcome.kind !== 'lapse') throw new Error('Expected a lapsed Proposal.');
    const { user, onPropose } = await setup({ state, again });
    const days = screen.getByRole('textbox', { name: 'Voting time (days)' });
    expect(days).toHaveValue('10');
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
    await user.click(submit());
    expect(onPropose.mock.calls[0]?.[0].window).toBe(10);
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps its draft under the Proposal it repeats, apart from the section’s own', async () => {
    const { state, again } = lapsed();
    const memory = memoryDrafts({
      [again.atom]: { title: 'Another idea', why: 'Why not.', text: 'Quiet.', link: '' },
    });
    await setup({ state, again, drafts: memory.drafts });
    expect(memory.drafts.load).toHaveBeenCalledWith(againDraft(again.id));
    expect(box('Title')).toHaveValue('Later quiet hours');
  });

  it('is an ordinary composer for a Proposal that didn’t lapse', async () => {
    const log = groupLog();
    const proposalId = log.propose('ana');
    log.vote('ana', proposalId, 4);
    log.vote('ben', proposalId, 4);
    const state = log.state();
    const passed = state.proposals[0];
    await setup({ state, ...(passed === undefined ? {} : { again: passed }) });
    expect(screen.getByRole('heading', { level: 1, name: 'Propose a change' })).toBeVisible();
    expect(box('Title')).toHaveValue('');
    expect(proposalId).toBe(passed?.id);
  });
});

describe('Composer drafts, against fake IndexedDB', () => {
  const devices: TestDevice[] = [];

  afterEach(() => {
    for (const device of devices.splice(0)) device.services.store.close();
  });

  /** A real device on fake-indexeddb with a founded, synced group, and its composer. */
  async function device() {
    const fake = createFakeRelay();
    const ana = await testDevice(fake, 'ana');
    devices.push(ana);
    const created = await createGroup(ana.services, {
      groupName: 'Riverside Tenants',
      yourName: 'Ana',
      chat: null,
      documents: [
        { title: 'House rules', text: 'Quiet hours start at ten.\n\nBins go out on Tuesday.' },
      ],
    });
    if (created.outcome !== 'created') throw new Error('Expected a group.');
    const { groupId } = created;
    await ana.services.sync.syncOnce();
    const group = await ana.services.store.getGroup(groupId);
    if (group === undefined) throw new Error('Expected the group.');
    const state = fold(group.log, group.relayNow);
    const me = group.me.author;
    const atomId = `${groupId}.0`;
    const drafts = groupDrafts(ana.services.store, groupId);
    const onPropose = async (values: ProposalValues): Promise<ComposeOutcome> =>
      (await propose(ana.services, groupId, values)).outcome;
    const open = async () => {
      const view = render(
        <Composer
          state={state}
          me={me}
          atomId={atomId}
          drafts={drafts}
          now={NOW}
          onPropose={onPropose}
          onAddVersion={vi.fn()}
        />,
      );
      await screen.findByRole('textbox', { name: 'Title' });
      return view;
    };
    const stored = () => ana.services.store.readDraft(groupId, atomId);
    return { open, stored, store: ana.services.store, groupId, fake, services: ana.services };
  }

  const TYPED: Draft = {
    title: 'Later quiet hours',
    why: 'Weekends run late.',
    text: 'Quiet after **11pm**.',
    link: 'https://chat.example.org/later',
  };

  async function type(user: UserEvent): Promise<void> {
    await fill(user, {
      Title: TYPED.title,
      Why: TYPED.why,
      'New text': TYPED.text,
      'Discussion link (optional)': TYPED.link,
    });
  }

  it('keeps a draft on this device that survives a remount, and says it’s back', async () => {
    const { open, stored } = await device();
    const user = userEvent.setup();
    const first = await open();
    await type(user);
    await waitFor(async () => {
      expect(await stored()).toEqual(TYPED);
    });
    first.unmount();

    await open();
    expect(box('Title')).toHaveValue(TYPED.title);
    expect(box('Why')).toHaveValue(TYPED.why);
    expect(box('New text')).toHaveValue(TYPED.text);
    expect(box('Discussion link (optional)')).toHaveValue(TYPED.link);
    expect(screen.getByText('Your draft is back. It’s saved on this device only.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('saves what was typed when the composer closes before the pause', async () => {
    const { open, stored } = await device();
    const user = userEvent.setup();
    const first = await open();
    await replace(user, 'Title', 'Quick');
    first.unmount();
    await waitFor(async () => {
      expect((await stored())?.title).toBe('Quick');
    });
  });

  it('clears the draft once its Proposal enters the outbox', async () => {
    const { open, stored, store, groupId, fake } = await device();
    const user = userEvent.setup();
    const first = await open();
    await type(user);
    await waitFor(async () => {
      expect(await stored()).toEqual(TYPED);
    });
    // Offline, so the Proposal stays in the outbox where the test can see it.
    fake.offline = true;
    await user.click(submit());
    await waitFor(async () => {
      expect((await store.getGroup(groupId))?.outbox).toHaveLength(1);
    });
    first.unmount();
    expect(await stored()).toBeUndefined();

    await open();
    expect(box('Title')).toHaveValue('');
    expect(box('New text')).toHaveValue('Quiet hours start at ten.\n');
    expect(screen.queryByText(/Your draft is back/)).not.toBeInTheDocument();
  });

  it('keeps a version’s draft under its Proposal, and clears it once the version is queued', async () => {
    const { store, groupId, fake, services } = await device();
    const atomId = `${groupId}.0`;
    const proposed = await propose(services, groupId, {
      atom: atomId,
      title: 'Later quiet hours',
      why: 'Weekends run late.',
      text: 'Quiet after 11pm.',
      link: null,
    });
    if (proposed.outcome !== 'proposed') throw new Error('Expected a Proposal.');
    await services.sync.syncOnce();
    const group = await store.getGroup(groupId);
    if (group === undefined) throw new Error('Expected the group.');
    const state = fold(group.log, group.relayNow);
    const drafts = groupDrafts(store, groupId);
    const onAddVersion = async (values: VersionValues): Promise<ComposeOutcome> =>
      (await addVersion(services, groupId, values)).outcome;
    const open = async () => {
      const view = render(
        <Composer
          state={state}
          me={group.me.author}
          atomId={atomId}
          drafts={drafts}
          now={NOW}
          onPropose={vi.fn()}
          onAddVersion={onAddVersion}
        />,
      );
      await screen.findByRole('textbox', { name: 'Your version' });
      return view;
    };
    const user = userEvent.setup();
    const first = await open();
    await replace(user, 'Your version', 'Quiet after midnight.');
    await waitFor(async () => {
      expect((await store.readDraft(groupId, proposed.proposalId))?.text).toBe(
        'Quiet after midnight.',
      );
    });
    first.unmount();

    const second = await open();
    expect(box('Your version')).toHaveValue('Quiet after midnight.');
    expect(screen.getByText('Your draft is back. It’s saved on this device only.')).toBeVisible();
    fake.offline = true;
    await user.click(addSubmit());
    await waitFor(async () => {
      expect((await store.getGroup(groupId))?.outbox).toHaveLength(1);
    });
    second.unmount();
    expect(await store.readDraft(groupId, proposed.proposalId)).toBeUndefined();
  });

  it('keeps a chosen voting time in the draft, and Discard sets it back to the default (#106)', async () => {
    const { open, stored } = await device();
    const user = userEvent.setup();
    const days = () => screen.getByRole('textbox', { name: 'Voting time (days)' });
    const first = await open();
    expect(days()).toHaveValue('7');
    await user.clear(days());
    await user.type(days(), '10');
    await user.tab();
    await waitFor(async () => {
      expect((await stored())?.window).toBe(10);
    });
    first.unmount();

    await open();
    expect(days()).toHaveValue('10');
    expect(screen.getByText('Your draft is back. It’s saved on this device only.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(days()).toHaveValue('7');
    await waitFor(async () => {
      expect(await stored()).toBeUndefined();
    });
  });

  it('discards the draft: gone from the device, and the form starts over', async () => {
    const { open, stored } = await device();
    const user = userEvent.setup();
    const first = await open();
    await type(user);
    await waitFor(async () => {
      expect(await stored()).toEqual(TYPED);
    });
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));

    expect(box('Title')).toHaveValue('');
    expect(box('Title')).toHaveFocus();
    expect(box('New text')).toHaveValue('Quiet hours start at ten.\n');
    expect(screen.getByRole('status')).toHaveTextContent('Draft discarded.');
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
    await waitFor(async () => {
      expect(await stored()).toBeUndefined();
    });
    first.unmount();
    expect(await stored()).toBeUndefined();

    await open();
    expect(box('Title')).toHaveValue('');
  });
});

describe('Composer: a suspended member (#102)', () => {
  it('shows the suspended line in place of the form', async () => {
    const log = groupLog({ members: ['Kim'] });
    log.suspend('Ana', 'Kim', 'Threats.');
    await setup({ state: log.state(), me: authorOf('kim') });
    expect(
      screen.getByText(
        /^A steward suspended you until .+\. You can read, but not post, propose or vote\.$/,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propose this change' })).toBeNull();
  });
});
