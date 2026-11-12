import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ComposeOutcome } from '../app/compose';
import { messages } from '../app/messages';
import {
  addDraft,
  againDraft,
  type ProposalValues,
  removalDraft,
  type VersionValues,
} from '../app/proposals';
import { LEVELS } from '../engine/capabilities';
import type { GroupState, Proposal } from '../engine/fold';
import type { Draft } from '../store/drafts';
import { axeViolations } from '../test/axe';
import { memoryDrafts } from '../test/drafts';
import { authorOf } from '../test/keys';
import { held, pastPressFallback } from '../test/press';
import { deadlineOf, groupLog, SETTLED_MINUTES, START_MINUTE } from '../test/votes';
import { AddSection, RemoveSection } from './SectionComposer';

type OnPropose = (values: ProposalValues) => Promise<ComposeOutcome>;
type OnAddVersion = (values: VersionValues) => Promise<ComposeOutcome>;

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

interface AddOptions {
  readonly state?: GroupState;
  readonly after?: number | null;
  readonly me?: string;
  readonly onPropose?: OnPropose;
  readonly drafts?: Readonly<Record<string, Draft>>;
  readonly again?: Proposal;
  /** A header's level (#103), or none for a section. */
  readonly heading?: 1 | 2;
}

/** Renders Add a section after Atom `after` (default: at the start) and waits for its heading. */
async function addSection(options: AddOptions = {}) {
  const state = options.state ?? groupLog({ chat: CHAT }).state();
  const after = options.after ?? null;
  const afterId = after === null ? null : `${state.group ?? ''}.${String(after)}`;
  const onPropose = vi.fn<OnPropose>(options.onPropose ?? (() => Promise.resolve('proposed')));
  const memory = memoryDrafts(options.drafts);
  render(
    <AddSection
      state={state}
      me={options.me ?? authorOf('ana')}
      after={afterId}
      drafts={memory.drafts}
      now={NOW}
      onPropose={onPropose}
      {...(options.again === undefined ? {} : { again: options.again })}
      {...(options.heading === undefined ? {} : { heading: options.heading })}
    />,
  );
  await screen.findByRole('heading', { level: 1 });
  return { user: userEvent.setup(), state, afterId, onPropose, memory };
}

interface RemoveOptions {
  readonly state?: GroupState;
  readonly atom?: number;
  readonly me?: string;
  readonly onPropose?: OnPropose;
  readonly onAddVersion?: OnAddVersion;
  readonly again?: Proposal;
}

/** Renders Propose removing this section for Atom `atom` (default: the second). */
async function removeSection(options: RemoveOptions = {}) {
  const state = options.state ?? groupLog({ chat: CHAT }).state();
  const atomId = `${state.group ?? ''}.${String(options.atom ?? 1)}`;
  const onPropose = vi.fn<OnPropose>(options.onPropose ?? (() => Promise.resolve('proposed')));
  const onAddVersion = vi.fn<OnAddVersion>(
    options.onAddVersion ?? (() => Promise.resolve('added')),
  );
  const memory = memoryDrafts();
  render(
    <RemoveSection
      state={state}
      me={options.me ?? authorOf('ana')}
      atomId={atomId}
      drafts={memory.drafts}
      now={NOW}
      onPropose={onPropose}
      onAddVersion={onAddVersion}
      {...(options.again === undefined ? {} : { again: options.again })}
    />,
  );
  await screen.findByRole('heading', { level: 1 });
  return { user: userEvent.setup(), state, atomId, onPropose, onAddVersion, memory };
}

describe('AddSection', () => {
  it('says the new section goes first, and starts with an empty text', async () => {
    const { state } = await addSection();
    expect(screen.getByRole('heading', { level: 1, name: 'Add a section' })).toBeVisible();
    expect(document.title).toBe('Add a section · Reconcile');
    expect(
      screen.getByText('If your group passes it, your section goes at the start of the Document.'),
    ).toBeVisible();
    expect(screen.queryByRole('region', { name: /now reads$/ })).not.toBeInTheDocument();
    expect(box('Title')).toHaveValue('');
    expect(box('Why')).toHaveValue('');
    expect(box('Section text')).toHaveValue('');
    expect(box('Section text')).toBeRequired();
    expect(box('Section text')).toHaveAccessibleDescription(
      `If your group passes it, this becomes a new section. ${HINT}`,
    );
    expect(box('Discussion link (optional)')).toHaveValue(CHAT);
    expect(screen.getByRole('link', { name: 'House rules' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/doc/${state.group ?? ''}`,
    );
    expect(screen.getByRole('button', { name: 'Propose this section' })).toBeEnabled();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the section the new one follows, as it reads now', async () => {
    await addSection({ after: 1 });
    expect(
      screen.getByText('If your group passes it, your section goes right after section 2.'),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'Section 2 now reads' })).toHaveTextContent(
      'Bins go out on Tuesday.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('hands over the add, with its spot as the target in place of an Atom', async () => {
    const { user, afterId, onPropose, state } = await addSection({ after: 0 });
    await fill(user, {
      Title: ' Guests ',
      Why: 'Guests come often.',
      'Section text': 'Guests leave by 11pm.',
      'Discussion link (optional)': '',
    });
    await user.click(screen.getByRole('button', { name: 'Propose this section' }));
    expect(onPropose).toHaveBeenCalledWith({
      target: { kind: 'add', document: state.group, after: afterId },
      title: 'Guests',
      why: 'Guests come often.',
      text: 'Guests leave by 11pm.',
      link: null,
      window: 7,
    });
  });

  it('sets the voting time, from the class default, and sends the days chosen (#106)', async () => {
    const { user, onPropose } = await addSection({ after: 0 });
    const days = screen.getByRole('textbox', { name: 'Voting time (days)' });
    expect(days).toHaveValue('7');
    await fill(user, { Title: 'Guests', Why: 'They visit.', 'Section text': 'Guests by 11.' });
    await replace(user, 'Voting time (days)', '10');
    await user.click(screen.getByRole('button', { name: 'Propose this section' }));
    expect(onPropose.mock.calls[0]?.[0].window).toBe(10);
    expect(await axeViolations()).toEqual([]);
  });

  it('refuses a voting time outside its class’s bounds, and sends nothing (#106)', async () => {
    const { user, onPropose } = await addSection();
    await fill(user, { Title: 'Guests', Why: 'They visit.', 'Section text': 'Guests by 11.' });
    await replace(user, 'Voting time (days)', '2');
    await user.click(screen.getByRole('button', { name: 'Propose this section' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Voting time (days)' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('refuses blank text, with the reason tied to the field', async () => {
    const { user, onPropose } = await addSection();
    await fill(user, { Title: 'Guests', Why: 'Guests come often.', 'Section text': ' \n ' });
    await user.click(screen.getByRole('button', { name: 'Propose this section' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(box('Section text')).toHaveAccessibleDescription(
      `If your group passes it, this becomes a new section. Write the new section. ${HINT}`,
    );
  });

  it('keeps a draft for each spot, apart from the drafts of the sections themselves', async () => {
    const group = groupLog().state();
    const atom = `${group.group ?? ''}.0`;
    const spot = addDraft({ document: group.group ?? '', after: atom });
    const atomDraft = { title: 'Mine', why: 'Mine.', text: 'Quiet after 9pm.', link: '' };
    const { user, memory } = await addSection({
      state: group,
      after: 0,
      drafts: { [atom]: atomDraft },
    });
    expect(box('Title')).toHaveValue('');
    await replace(user, 'Section text', 'Guests leave by 11pm.');
    await waitFor(() => {
      expect(memory.shelf.get(spot)).toMatchObject({ text: 'Guests leave by 11pm.' });
    });
    expect(memory.shelf.get(atom)).toEqual(atomDraft);
    expect(memory.drafts.load).toHaveBeenCalledWith(spot);
  });

  it('says when the section it would follow isn’t in the Document', async () => {
    const state = groupLog().state();
    const memory = memoryDrafts();
    render(
      <AddSection
        state={state}
        me={authorOf('ana')}
        after="missing.0"
        drafts={memory.drafts}
        now={NOW}
        onPropose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section isn’t in the Document' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(memory.drafts.load).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no form to someone who may not propose', async () => {
    const log = groupLog();
    log.join('Kim', VOTING);
    await addSection({ state: log.state(), me: authorOf('kim') });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You can’t propose changes here' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('AddSection: headers (#103)', () => {
  it('asks for one Heading line in place of the section text, and nothing else new', async () => {
    await addSection({ after: 0, heading: 1 });
    expect(screen.getByRole('heading', { level: 1, name: 'Add a section header' })).toBeVisible();
    expect(document.title).toBe('Add a section header · Reconcile');
    expect(
      screen.getByText('If your group passes it, your section goes right after section 1.'),
    ).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Section text' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    const heading = box('Heading');
    expect(heading.tagName).toBe('INPUT');
    expect(heading).toBeRequired();
    expect(heading).toHaveAccessibleDescription(
      'One line. If your group passes it, it shows as a section header.',
    );
    const order = Array.from(document.querySelectorAll('form .field label')).map(
      (label) => label.textContent,
    );
    expect(order.slice(0, 4)).toEqual(['Title', 'Why', 'Heading', 'Discussion link (optional)']);
    expect(screen.getByRole('button', { name: 'Propose this header' })).toBeEnabled();
    expect(await axeViolations()).toEqual([]);
  });

  it('prefills the title from the heading, which stays editable, and hands over “# <heading>”', async () => {
    const { user, state, afterId, onPropose } = await addSection({ after: 0, heading: 1 });
    await user.click(box('Heading'));
    await user.paste('Values');
    expect(box('Title')).toHaveValue('Add section header: Values');
    await fill(user, { Why: 'An outline first.' });
    await user.click(screen.getByRole('button', { name: 'Propose this header' }));
    expect(onPropose).toHaveBeenCalledWith({
      target: { kind: 'add', document: state.group, after: afterId },
      heading: 1,
      title: 'Add section header: Values',
      why: 'An outline first.',
      text: '# Values',
      link: CHAT,
      window: 7,
    });
  });

  it('stops following the heading once the title is changed by hand', async () => {
    const { user, onPropose } = await addSection({ heading: 1 });
    await user.click(box('Heading'));
    await user.paste('Values');
    await fill(user, { Title: 'Our values first', Why: 'An outline.' });
    await user.click(box('Heading'));
    await user.paste(' we share');
    expect(box('Title')).toHaveValue('Our values first');
    await user.click(screen.getByRole('button', { name: 'Propose this header' }));
    expect(onPropose.mock.calls[0]?.[0]).toMatchObject({
      title: 'Our values first',
      text: '# Values we share',
    });
  });

  it('builds a subsection header as “## <heading>”, titled as one', async () => {
    const { user, onPropose } = await addSection({ after: 1, heading: 2 });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Add a subsection header' }),
    ).toBeVisible();
    expect(box('Heading')).toHaveAccessibleDescription(
      'One line. If your group passes it, it shows as a subsection header.',
    );
    await user.click(box('Heading'));
    await user.paste('Organization');
    expect(box('Title')).toHaveValue('Add subsection header: Organization');
    await fill(user, { Why: 'How we work.' });
    await user.click(screen.getByRole('button', { name: 'Propose this header' }));
    expect(onPropose.mock.calls[0]?.[0]).toMatchObject({ heading: 2, text: '## Organization' });
  });

  it('refuses a blank heading, with the reason tied to the field', async () => {
    const { user, onPropose } = await addSection({ heading: 1 });
    await fill(user, { Title: 'A header', Why: 'An outline.' });
    await user.click(box('Heading'));
    await user.paste('   ');
    await user.click(screen.getByRole('button', { name: 'Propose this header' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(box('Heading')).toHaveAccessibleDescription(
      'One line. If your group passes it, it shows as a section header. Write the heading.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps its draft apart from a section’s at the same spot, and brings it back', async () => {
    const state = groupLog({ chat: CHAT }).state();
    const place = { document: state.group ?? '', after: null };
    const section = { title: 'Guests', why: 'They visit.', text: 'Guests by 11.', link: '' };
    const header = {
      title: 'Add section header: Values',
      why: 'An outline.',
      text: '# Values',
      link: '',
    };
    await addSection({
      state,
      heading: 1,
      drafts: { [addDraft(place)]: section, [addDraft(place, 1)]: header },
    });
    expect(await screen.findByText(/Your draft is back/)).toBeVisible();
    expect(box('Heading')).toHaveValue('Values');
    expect(box('Title')).toHaveValue('Add section header: Values');
  });
});

describe('RemoveSection', () => {
  it('asks for a title and why beside the section struck through, with no text to write', async () => {
    const { state } = await removeSection();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Propose removing this section' }),
    ).toBeVisible();
    expect(document.title).toBe('Propose removing a section · Reconcile');
    expect(
      screen.getByText('If your group passes it, this section leaves the Document.'),
    ).toBeVisible();
    const struck = screen.getByRole('region', { name: 'Section 2 now reads' });
    expect(struck.querySelector('del')).toHaveTextContent('Bins go out on Tuesday.');
    expect(struck.querySelector('ins')).toBeNull();
    expect(within(struck).getByText('removed')).toHaveClass('visually-hidden');
    expect(box('Title')).toHaveValue('');
    expect(box('Why')).toHaveValue('');
    expect(box('Discussion link (optional)')).toHaveValue(CHAT);
    expect(screen.queryByRole('textbox', { name: /text/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'House rules' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/doc/${state.group ?? ''}`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('hands over an edit whose text is empty', async () => {
    const { user, atomId, onPropose } = await removeSection();
    await fill(user, { Title: 'No bins rule', Why: 'The council collects now.' });
    await user.click(screen.getByRole('button', { name: 'Propose removing it' }));
    expect(onPropose).toHaveBeenCalledWith({
      atom: atomId,
      title: 'No bins rule',
      why: 'The council collects now.',
      text: '',
      link: CHAT,
      window: 7,
    });
  });

  it('sets a removal’s voting time, and sends the days chosen (#106)', async () => {
    const { user, onPropose } = await removeSection();
    expect(screen.getByRole('textbox', { name: 'Voting time (days)' })).toHaveValue('7');
    await fill(user, { Title: 'No bins rule', Why: 'The council collects now.' });
    await replace(user, 'Voting time (days)', '14');
    await user.click(screen.getByRole('button', { name: 'Propose removing it' }));
    expect(onPropose.mock.calls[0]?.[0].window).toBe(14);
  });

  it('keeps its draft under the removal, apart from the section’s own draft', async () => {
    const { user, atomId, memory } = await removeSection();
    await replace(user, 'Title', 'No bins rule');
    await waitFor(() => {
      expect(memory.shelf.get(removalDraft(atomId))).toMatchObject({ title: 'No bins rule' });
    });
    expect(memory.shelf.has(atomId)).toBe(false);
  });

  it('names a missing title and why, and sends nothing', async () => {
    const { user, onPropose } = await removeSection();
    await user.click(screen.getByRole('button', { name: 'Propose removing it' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(box('Title')).toHaveAttribute('aria-invalid', 'true');
    expect(box('Why')).toHaveAttribute('aria-invalid', 'true');
  });

  it('on a section with an open Proposal, adds the removal to its ballot, with no title or why', async () => {
    const log = groupLog({ chat: CHAT });
    const proposal = log.propose('ben', { atom: 1, title: 'Bins on Monday' });
    const { user, onAddVersion, onPropose, memory } = await removeSection({ state: log.state() });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Propose removing this section' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        'This section already has an open Proposal. Removing it goes on that ballot as another version, and everyone scores each version.',
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('region', { name: 'Section 2 now reads' }).querySelector('del'),
    ).toHaveTextContent('Bins go out on Tuesday.');
    // A version runs in its Proposal's window, so it has no voting time of its own (#106).
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      screen.getByText('Everyone in your group sees this version and that you added it.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Bins on Monday' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/p/${proposal}`,
    );
    expect(await axeViolations()).toEqual([]);
    const add = screen.getByRole('button', { name: 'Add removal to the ballot' });
    await user.click(add);
    expect(onAddVersion).toHaveBeenCalledWith({ proposal, text: '' });
    expect(onPropose).not.toHaveBeenCalled();
    expect(add).toBeDisabled();
    expect(memory.drafts.load).not.toHaveBeenCalled();
  });

  it('says so when adding the removal couldn’t be saved, and lets them try again', async () => {
    const log = groupLog();
    log.propose('ben', { atom: 1 });
    const onAddVersion = vi.fn<OnAddVersion>(() => Promise.reject(new Error('quota')));
    const { user } = await removeSection({ state: log.state(), onAddVersion });
    await user.click(screen.getByRole('button', { name: 'Add removal to the ballot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your version couldn’t be saved on this device. Try again.',
    );
    expect(screen.getByRole('button', { name: 'Add removal to the ballot' })).toBeEnabled();
  });

  it('adds the removal once when it is tapped again while it adds and the save fails (#193)', async () => {
    const log = groupLog();
    log.propose('ben', { atom: 1 });
    const adding = held<ComposeOutcome>();
    const onAddVersion = vi.fn<OnAddVersion>(() => adding.promise);
    const { user } = await removeSection({ state: log.state(), onAddVersion });
    const add = screen.getByRole('button', { name: 'Add removal to the ballot' });
    await user.click(add);
    expect(add).toBeDisabled();
    await user.click(add);
    adding.resolve('failed');
    expect(await screen.findByRole('alert')).toBeVisible();
    await pastPressFallback();
    expect(add).toBeEnabled();
    expect(onAddVersion).toHaveBeenCalledTimes(1);
  });

  it('says a removal is already on the section’s ballot, with no form', async () => {
    const log = groupLog();
    const proposal = log.propose('ben', { atom: 1 });
    log.version('ana', proposal, '');
    await removeSection({ state: log.state() });
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Removing this section is already on the ballot',
      }),
    ).toBeVisible();
    expect(screen.getByText('Score it on the section’s open Proposal.')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says the section is being moved, with no form, while a move of it is open (#103)', async () => {
    const log = groupLog();
    log.move('ben', `${log.group}.1`, null);
    await removeSection({ state: log.state() });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section is being moved' }),
    ).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says the ballot is full once it holds three versions', async () => {
    const log = groupLog();
    const proposal = log.propose('ben', { atom: 1 });
    log.version('ana', proposal, 'Bins on Monday.\n');
    log.version('ana', proposal, 'Bins on Friday.\n');
    await removeSection({ state: log.state() });
    expect(screen.getByRole('heading', { level: 1, name: 'This ballot is full' })).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says when the section isn’t in the Document, and offers nothing to someone who can’t propose', async () => {
    const log = groupLog();
    log.join('Kim', VOTING);
    const state = log.state();
    const memory = memoryDrafts();
    const { unmount } = render(
      <RemoveSection
        state={state}
        me={authorOf('ana')}
        atomId="missing.0"
        drafts={memory.drafts}
        now={NOW}
        onPropose={vi.fn()}
        onAddVersion={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section isn’t in the Document' }),
    ).toBeVisible();
    unmount();
    await removeSection({ state, me: authorOf('kim') });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You can’t propose changes here' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

/** Ana and Ben's group with its first section made `to` by a passed class Proposal (#116). */
function protectedGroup(to: 'entrenched' | 'eternal'): GroupState {
  const log = groupLog({ chat: CHAT });
  const proposal = log.protect('Ana', `${log.group}.0`, to);
  log.vote('Ana', proposal, 4);
  log.vote('Ben', proposal, 4);
  return log.state();
}

const ENTRENCHED_NOTE =
  'This section is entrenched. Changing, moving or removing it needs your group’s higher bar: an average of 3.0 or more, with zeros under 5%, and a longer vote.';

describe('RemoveSection on a protected section (#116)', () => {
  it('says removing an entrenched section needs the higher bar, and runs 14 days to start', async () => {
    await removeSection({ state: protectedGroup('entrenched'), atom: 0 });
    expect(screen.getByText(ENTRENCHED_NOTE)).toBeVisible();
    expect(box('Voting time (days)')).toHaveValue('14');
    expect(await axeViolations()).toEqual([]);
  });

  it('shows no form for an eternal section', async () => {
    await removeSection({ state: protectedGroup('eternal'), atom: 0 });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section is eternal' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /Propose removing it|Add removal/ })).toBeNull();
  });

  it('shows no form while a vote on the section’s protection is open', async () => {
    const log = groupLog({ chat: CHAT });
    log.protect('Ana', `${log.group}.1`, 'eternal');
    await removeSection({ state: log.state() });
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'This section’s protection is being decided',
      }),
    ).toBeVisible();
  });
});

describe('Adding or removing while a leave waits for the relay (#77)', () => {
  it('shows no add or removal form, and says why', async () => {
    const state = groupLog().state();
    const memory = memoryDrafts();
    const { unmount } = render(
      <AddSection
        state={state}
        me={authorOf('ana')}
        after={null}
        drafts={memory.drafts}
        now={NOW}
        onPropose={vi.fn()}
        leaving
      />,
    );
    const title = messages.leave.noProposingTitle;
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    unmount();
    render(
      <RemoveSection
        state={state}
        me={authorOf('ana')}
        atomId={`${state.group ?? ''}.0`}
        drafts={memory.drafts}
        now={NOW}
        onPropose={vi.fn()}
        onAddVersion={vi.fn()}
        leaving
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(screen.getByText(messages.leave.noProposing)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(memory.drafts.load).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });
});

describe('Adding or removing as a newcomer still earning a vote (#101)', () => {
  it('offers no add or removal form until their vote arrives, though they chose Co-Creator', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'], newcomers: ['Kim'] });
    const kim = authorOf('kim');
    const title = messages.composer.notAllowedTitle;
    await addSection({ state: log.state(), me: kim });
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    cleanup();
    await removeSection({ state: log.state(), me: kim });
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
    cleanup();
    log.vouch('ana', 'kim');
    log.vouch('ben', 'kim');
    const settled = log.state(log.minute + SETTLED_MINUTES);
    await addSection({ state: settled, me: kim });
    expect(box('Section text')).toBeVisible();
    cleanup();
    await removeSection({ state: settled, me: kim });
    expect(box('Title')).toBeVisible();
  });
});

describe('AddSection and RemoveSection in a group of several Documents (#92)', () => {
  const DOCUMENTS = [
    { title: 'Mission statement', atoms: ['We share.\n'] },
    { title: 'House rules', atoms: ['Quiet after 11pm.\n', 'Bins go out on Tuesday.\n'] },
  ];
  const ENTRIES = { Title: 'Guests', Why: 'They visit.', 'Section text': 'Guests leave.' };

  /** Renders Add a section with the route's `after` and `document`, as App passes them. */
  async function addIn(state: GroupState, after: string | null, document?: string) {
    const onPropose = vi.fn<OnPropose>(() => Promise.resolve('proposed'));
    render(
      <AddSection
        state={state}
        me={authorOf('ana')}
        after={after}
        {...(document === undefined ? {} : { document })}
        drafts={memoryDrafts().drafts}
        now={NOW}
        onPropose={onPropose}
      />,
    );
    await screen.findByRole('heading', { level: 1 });
    return { user: userEvent.setup(), onPropose };
  }

  it('adds at the start of the Document the route names, and links back to it', async () => {
    const state = groupLog({ documents: DOCUMENTS }).state();
    const second = `${state.group ?? ''}:1`;
    const { user, onPropose } = await addIn(state, null, second);
    expect(screen.getByRole('link', { name: 'House rules' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/doc/${second}`,
    );
    await fill(user, ENTRIES);
    await user.click(screen.getByRole('button', { name: 'Propose this section' }));
    expect(onPropose.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'add', document: second, after: null },
    });
    expect(await axeViolations()).toEqual([]);
  });

  it('adds after a section of the second Document, in that Document, numbered within it', async () => {
    const state = groupLog({ documents: DOCUMENTS }).state();
    const second = `${state.group ?? ''}:1`;
    const { user, onPropose } = await addIn(state, `${second}.1`);
    expect(
      screen.getByText('If your group passes it, your section goes right after section 2.'),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'Section 2 now reads' })).toHaveTextContent(
      'Bins go out on Tuesday.',
    );
    await fill(user, ENTRIES);
    await user.click(screen.getByRole('button', { name: 'Propose this section' }));
    expect(onPropose.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'add', document: second, after: `${second}.1` },
    });
  });

  it('says a Document the route names isn’t in this group, with no form', async () => {
    const state = groupLog({ documents: DOCUMENTS }).state();
    await addIn(state, null, `${state.group ?? ''}:2`);
    expect(
      screen.getByRole('heading', { level: 1, name: 'This Document isn’t in this group' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Riverside Tenants' })).toBeVisible();
  });

  it('removes a section of the second Document, numbered within it, and links back to it', async () => {
    const state = groupLog({ documents: DOCUMENTS }).state();
    const second = `${state.group ?? ''}:1`;
    render(
      <RemoveSection
        state={state}
        me={authorOf('ana')}
        atomId={`${second}.1`}
        drafts={memoryDrafts().drafts}
        now={NOW}
        onPropose={vi.fn()}
        onAddVersion={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('region', { name: 'Section 2 now reads' })).toHaveTextContent(
      'Bins go out on Tuesday.',
    );
    expect(screen.getByRole('link', { name: 'House rules' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/doc/${second}`,
    );
  });
});

describe('Send a Dispatch if this passes, on an add or a removal (#75, #112)', () => {
  const { composer } = messages;
  const choice = () => screen.getByRole('checkbox', { name: composer.dispatchLabel });

  it('offers it unchecked on Add a section, and the add carries what it opens', async () => {
    const { user, afterId, onPropose, state } = await addSection({ after: 0 });
    expect(choice()).not.toBeChecked();
    await fill(user, {
      Title: 'Guests',
      Why: 'Guests come often.',
      'Section text': 'Guests leave.',
    });
    await user.click(choice());
    expect(box(composer.dispatchTitleLabel)).toHaveValue('Updated: House rules');
    await user.click(box(composer.dispatchTextLabel));
    await user.paste('A rule for guests.');
    expect(await axeViolations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Propose this section' }));
    expect(onPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'add', document: state.group, after: afterId },
        dispatch: { title: 'Updated: House rules', text: 'A rule for guests.' },
      }),
    );
  });

  it('offers it on Propose removing this section, and the removal carries it', async () => {
    const { user, atomId, onPropose } = await removeSection();
    await fill(user, { Title: 'No bins rule', Why: 'The council collects now.' });
    await user.click(choice());
    await user.click(screen.getByRole('button', { name: 'Propose removing it' }));
    expect(onPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        atom: atomId,
        text: '',
        dispatch: { title: 'Updated: House rules', text: '' },
      }),
    );
  });

  it('offers none when the removal only joins an open ballot, which carries its own', async () => {
    const log = groupLog({ chat: CHAT });
    log.propose('ben', { atom: 1, title: 'Bins on Monday', text: 'Bins go out on Monday.\n' });
    await removeSection({ state: log.state() });
    expect(screen.getByRole('button', { name: composer.removeVersionSubmit })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: composer.dispatchLabel })).toBeNull();
  });

  it('starts a lapsed add again with the Dispatch it carried', async () => {
    const log = groupLog({ chat: CHAT });
    const dispatch = { title: 'Updated: House rules', text: 'Guests have a rule.' };
    const id = log.addSection('ana', `${log.group}.0`, { title: 'Guests', dispatch });
    const state = log.state(deadlineOf(START_MINUTE));
    const add = state.proposals.find((proposal) => proposal.id === id);
    if (add === undefined) throw new Error('Expected the add.');
    expect(add.dispatch).toEqual(dispatch);
    const { user, onPropose } = await addSection({ state, after: 0, again: add });
    expect(choice()).toBeChecked();
    expect(box(composer.dispatchTextLabel)).toHaveValue('Guests have a rule.');
    await user.click(screen.getByRole('button', { name: 'Propose this section' }));
    expect(onPropose).toHaveBeenCalledWith(expect.objectContaining({ again: id, dispatch }));
  });
});

describe('Proposing an add or a removal again (#74)', () => {
  /** Ana's add after section 1 and her removal of section 2, Ben's versions on each, and no ballots: both lapse. */
  function lapsedBoth() {
    const log = groupLog({ chat: CHAT });
    const add = log.addSection('ana', `${log.group}.0`, { title: 'Guests', why: 'They visit.' });
    log.version('ben', add, 'Guests leave by midnight.\n');
    const removal = log.propose('ana', { atom: 1, title: 'No bins rule', text: '' });
    log.version('ben', removal, 'Bins go out on Monday.\n');
    const state = log.state(deadlineOf(START_MINUTE));
    const find = (id: string) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (proposal === undefined) throw new Error('Expected the Proposal.');
      return proposal;
    };
    return { state, add: find(add), removal: find(removal) };
  }

  it('starts an add from the lapsed one, keeps its draft under it, and carries its versions', async () => {
    const { state, add } = lapsedBoth();
    const { user, onPropose, afterId, memory } = await addSection({ state, after: 0, again: add });
    expect(screen.getByRole('heading', { level: 1, name: 'Propose again' })).toBeVisible();
    expect(box('Title')).toHaveValue('Guests');
    expect(box('Section text')).toHaveValue('Guests leave by 11pm.\n');
    expect(screen.getByRole('region', { name: 'Also on the ballot' })).toHaveTextContent(
      'Guests leave by midnight.',
    );
    expect(memory.drafts.load).toHaveBeenCalledWith(againDraft(add.id));
    expect(await axeViolations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Propose this section' }));
    expect(onPropose).toHaveBeenCalledWith({
      target: { kind: 'add', document: state.group, after: afterId },
      title: 'Guests',
      why: 'They visit.',
      text: 'Guests leave by 11pm.\n',
      link: CHAT,
      window: 7,
      again: add.id,
      versions: ['Guests leave by midnight.\n'],
    });
  });

  it('starts a removal from the lapsed one, with its rewording carried onto the ballot', async () => {
    const { state, removal } = lapsedBoth();
    const { user, onPropose, atomId } = await removeSection({ state, again: removal });
    expect(screen.getByRole('heading', { level: 1, name: 'Propose again' })).toBeVisible();
    expect(box('Title')).toHaveValue('No bins rule');
    expect(
      screen.getByRole('region', { name: 'Section 2 now reads' }).querySelector('del'),
    ).toHaveTextContent('Bins go out on Tuesday.');
    await user.click(screen.getByRole('button', { name: 'Propose removing it' }));
    expect(onPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        atom: atomId,
        text: '',
        again: removal.id,
        versions: ['Bins go out on Monday.\n'],
      }),
    );
  });

  it('starts fresh when the Proposal it names hasn’t lapsed', async () => {
    const log = groupLog();
    const add = log.addSection('ana', null);
    const open = log.state().proposals.find((proposal) => proposal.id === add);
    await addSection({ state: log.state(), ...(open === undefined ? {} : { again: open }) });
    expect(screen.getByRole('heading', { level: 1, name: 'Add a section' })).toBeVisible();
    expect(box('Title')).toHaveValue('');
  });
});
