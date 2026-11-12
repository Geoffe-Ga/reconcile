import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { testGroup } from '../test/groups';
import { authorOf } from '../test/keys';
import { groupLog, SETTLED_MINUTES } from '../test/votes';
import type { CoalitionStanding } from '../app/coalitionHome';
import { messages } from '../app/messages';
import type { Atom } from '../engine/fold';
import { type AddPlace, CoalitionDocumentView, DocumentView } from './DocumentView';

const [FOLLOWING, VOTING] = LEVELS;

/** What the Document view reports, and its clipboard. */
interface Handlers {
  /** Whether this device's leave waits for the relay (#77). */
  readonly leaving?: boolean;
  readonly onPropose?: (atomId: string) => void;
  readonly onAdd?: (place: AddPlace) => void;
  readonly onMove?: (atomId: string) => void;
  /** The Document on screen (#92); the group's first when absent. */
  readonly documentId?: string;
  readonly onRemove?: (atomId: string) => void;
  readonly copyText?: (text: string) => Promise<void>;
}

/** The Document view as `me` (default: the founder, Ana, a Co-Creator) sees it. */
function view(
  state: GroupState,
  me = authorOf('ana'),
  onPropose = vi.fn(),
  handlers: Handlers = {},
) {
  return render(
    <DocumentView
      state={state}
      me={me}
      onPropose={onPropose}
      onAdd={handlers.onAdd ?? vi.fn()}
      onRemove={handlers.onRemove ?? vi.fn()}
      onMove={handlers.onMove ?? vi.fn()}
      copyText={handlers.copyText ?? vi.fn(() => Promise.resolve())}
      leaving={handlers.leaving ?? false}
      {...(handlers.documentId === undefined ? {} : { documentId: handlers.documentId })}
    />,
  );
}

/** Opens the Add a section here named `gap` and picks `choice`: a section or a header (#103). */
async function addVia(user: ReturnType<typeof userEvent.setup>, gap: string, choice = 'Section') {
  await user.click(screen.getByRole('button', { name: gap }));
  await user.click(await screen.findByRole('menuitem', { name: choice }));
}

describe('DocumentView', () => {
  it('sets each section in the document style, under the title', async () => {
    const { state } = testGroup({
      atoms: ['Quiet hours start at ten.', 'Bins go out\non Tuesday.'],
    });
    const { container } = view(state);

    expect(screen.getByRole('heading', { level: 1, name: 'House rules' })).toBeVisible();
    const texts = Array.from(container.querySelectorAll('.atom-text'));
    expect(texts.map((node) => node.textContent)).toEqual([
      'Quiet hours start at ten.',
      'Bins go out\non Tuesday.',
    ]);
    expect(texts[0]).toHaveAttribute('dir', 'auto');
    expect(screen.getByRole('link', { name: 'Riverside Tenants' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}`,
    );
    expect(document.title).toBe('Document · Reconcile');
    expect(await axeViolations()).toEqual([]);
  });

  it('formats each section’s Markdown through AtomText, an Atom’s # under the page’s h1', async () => {
    const { state } = testGroup({
      atoms: [
        '# Our rules\n',
        'Be *kind*, and **ask first**. See [our site](https://example.org).\n',
        '- Quiet after ten\n- Bins on Tuesday\n',
      ],
    });
    const { container } = view(state);
    expect(screen.getByRole('heading', { level: 2, name: 'Our rules' })).toBeVisible();
    expect(screen.getByText('kind', { selector: 'em' })).toBeVisible();
    expect(screen.getByText('ask first', { selector: 'strong' })).toBeVisible();
    expect(screen.getByRole('link', { name: /our site/ })).toHaveAttribute(
      'href',
      'https://example.org/',
    );
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
    expect(container.querySelectorAll('.atom > .atom-text')).toHaveLength(3);
    expect(await axeViolations()).toEqual([]);
  });

  it('never follows a javascript: link in a section', () => {
    const { state } = testGroup({
      atoms: ['[click](javascript:alert(1)) <javascript:alert(2)>\n'],
    });
    const { container } = view(state);
    expect(container.querySelector('.atom-text a')).toBeNull();
    expect(container.querySelector('.atom-text')).toHaveTextContent('click');
  });

  it('never renders a section’s text as HTML', () => {
    const { state } = testGroup({ atoms: ['<img src=x onerror=alert(1)> and <b>bold</b>'] });
    const { container } = view(state);
    expect(container.querySelector('.atom-text img, .atom-text b')).toBeNull();
    expect(container.querySelector('.atom-text')).toHaveTextContent(
      '<img src=x onerror=alert(1)> and <b>bold</b>',
    );
  });

  it('offers Propose a change on each section to someone who may propose', () => {
    const { state } = testGroup();
    view(state);
    const buttons = screen.getAllByRole('button', { name: /^Propose a change/ });
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Propose a change to section 1',
      'Propose a change to section 2',
    ]);
    for (const button of buttons) {
      expect(button).toHaveTextContent('Propose a change');
      expect(button).toBeEnabled();
    }
    expect(screen.queryByRole('link', { name: /involvement/ })).not.toBeInTheDocument();
  });

  it('proposes on the section pressed', async () => {
    const user = userEvent.setup();
    const { state } = testGroup();
    const onPropose = vi.fn();
    view(state, authorOf('ana'), onPropose);
    await user.click(screen.getByRole('button', { name: 'Propose a change to section 2' }));
    expect(onPropose).toHaveBeenCalledWith(`${state.group ?? ''}.1`);
  });

  it('tells a newcomer at the creating level when their vote arrives, with no Propose or level link (#101)', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'], newcomers: ['Kim'] });
    view(log.state(), authorOf('kim'));
    expect(screen.queryByRole('button', { name: /^Propose a change/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /^You can vote on Proposals that open after .+, once 2 people vouch for you\.$/,
      ),
    ).toBeVisible();
    expect(screen.queryByText(/^You’re following this group/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Change your involvement' })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers a newcomer no section to add or remove until their vote arrives, though they copy it (#75, #101)', async () => {
    const user = userEvent.setup();
    const log = groupLog({ members: ['Ben', 'Cal'], newcomers: ['Kim'] });
    const copyText = vi.fn(() => Promise.resolve());
    view(log.state(), authorOf('kim'), vi.fn(), { copyText });
    expect(screen.queryByRole('button', { name: /^Add a section here/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Propose removing this section/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    expect(copyText).toHaveBeenCalledWith('Quiet hours start at ten.\nBins go out on Tuesday.');
    expect(await axeViolations()).toEqual([]);
    cleanup();
    log.vouch('ana', 'kim');
    log.vouch('ben', 'kim');
    view(log.state(log.minute + SETTLED_MINUTES), authorOf('kim'));
    expect(screen.getAllByRole('button', { name: /^Add a section here/ })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /^Propose removing this section/ })).toHaveLength(
      2,
    );
  });

  it('tells a Member they follow, offers no Propose, and points to where they choose', async () => {
    const { state } = testGroup({ joiners: ['Kim'], levels: { Kim: FOLLOWING } });
    view(state, authorOf('kim'));
    expect(screen.queryByRole('button', { name: /^Propose a change/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'You’re following this group. Choose Collaborator or Co-Creator to vote or propose.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Change your involvement' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}`,
    );
    expect(screen.getByText('Quiet hours start at ten.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('tells a Collaborator they vote here, and how to propose', async () => {
    const { state } = testGroup({ joiners: ['Ben'], levels: { Ben: VOTING } });
    view(state, authorOf('ben'));
    expect(screen.queryByRole('button', { name: /^Propose a change/ })).not.toBeInTheDocument();
    expect(
      screen.getByText('You vote on changes here. Choose Co-Creator to propose them.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Change your involvement' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says nothing about levels to someone whose join hasn’t reached the relay', () => {
    const { state } = testGroup();
    view(state, authorOf('cy'));
    expect(screen.queryByRole('button', { name: /^Propose a change/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /involvement/ })).not.toBeInTheDocument();
    expect(screen.getByText('Quiet hours start at ten.')).toBeVisible();
  });

  it('turns Propose a change into Add your version on a section with an open Proposal', async () => {
    const user = userEvent.setup();
    const log = groupLog();
    log.propose('ana');
    const state = log.state();
    const onPropose = vi.fn();
    view(state, authorOf('ana'), onPropose);
    const add = screen.getByRole('button', { name: 'Add your version to section 1' });
    expect(add).toHaveTextContent('Add your version');
    expect(screen.getByRole('button', { name: 'Propose a change to section 2' })).toBeVisible();
    await user.click(add);
    expect(onPropose).toHaveBeenCalledWith(`${log.group}.0`);
    expect(await axeViolations()).toEqual([]);
  });

  it('says a section’s ballot is full once it holds three versions, with no button but Move and History', async () => {
    const log = groupLog();
    const proposal = log.propose('ana');
    log.version('ben', proposal, 'Quiet after midnight.');
    log.version('ben', proposal, 'Quiet after 10pm.');
    view(log.state());
    expect(screen.getByText('This section’s ballot already has three versions.')).toBeVisible();
    expect(
      screen
        .getAllByRole('button', { name: /section [12]$/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Move this section, section 1',
      'History of section 1',
      'Add a section here, after section 1',
      'Propose a change to section 2',
      'Propose removing this section, section 2',
      'Move this section, section 2',
      'History of section 2',
      'Add a section here, after section 2',
    ]);
    expect(await axeViolations()).toEqual([]);
  });

  it('says so when the Document has no sections, and offers a first one', async () => {
    const user = userEvent.setup();
    // Genesis founds no empty Document (#92), so its one section is removed by vote.
    const log = groupLog({ atoms: ['Only this.\n'] });
    const removal = log.propose('Ana', { text: '' });
    log.vote('Ana', removal, 4);
    log.vote('Ben', removal, 4);
    const state = log.state();
    const onAdd = vi.fn();
    view(state, authorOf('ana'), vi.fn(), { onAdd });
    expect(screen.getByText('This Document has no sections yet.')).toBeVisible();
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Add a section here, at the start']);
    expect(screen.queryByRole('button', { name: 'Copy as Markdown' })).not.toBeInTheDocument();
    await addVia(user, 'Add a section here, at the start');
    expect(onAdd).toHaveBeenCalledWith({ document: state.group, after: null });
    expect(await axeViolations()).toEqual([]);
  });

  it('offers a quiet Add a section here at the start, between sections and at the end', async () => {
    const user = userEvent.setup();
    const { state } = testGroup();
    const onAdd = vi.fn();
    const { container } = view(state, authorOf('ana'), vi.fn(), { onAdd });
    const gaps = screen.getAllByRole('button', { name: /^Add a section/ });
    expect(gaps.map((gap) => gap.getAttribute('aria-label'))).toEqual([
      'Add a section here, at the start',
      'Add a section here, after section 1',
      'Add a section here, after section 2',
    ]);
    for (const gap of gaps) expect(gap).toHaveTextContent('Add a section here');
    const order = Array.from(container.querySelectorAll('.document > *')).map(
      (node) => node.className,
    );
    expect(order).toEqual(['atom-gap', 'atom', 'atom-gap', 'atom', 'atom-gap']);
    await addVia(user, 'Add a section here, at the start');
    await addVia(user, 'Add a section here, after section 2');
    const first = state.group ?? '';
    expect(onAdd.mock.calls).toEqual([
      [{ document: first, after: null }],
      [{ document: first, after: `${first}.1` }],
    ]);
    expect(await axeViolations()).toEqual([]);
  });

  it('names every button with its visible words first, so speaking them presses it (WCAG 2.5.3)', () => {
    const log = groupLog();
    log.propose('ana');
    view(log.state());
    const buttons = screen.getAllByRole('button');
    // Each section's Move (#103) and History (#104) among them.
    expect(buttons).toHaveLength(12);
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') ?? button.textContent;
      expect(name.startsWith(button.textContent)).toBe(true);
    }
  });

  it('offers Propose removing this section on each section, and opens it for the one pressed', async () => {
    const user = userEvent.setup();
    const { state } = testGroup();
    const onRemove = vi.fn();
    view(state, authorOf('ana'), vi.fn(), { onRemove });
    const buttons = screen.getAllByRole('button', { name: /^Propose removing/ });
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Propose removing this section, section 1',
      'Propose removing this section, section 2',
    ]);
    for (const button of buttons) expect(button).toHaveTextContent('Propose removing this section');
    await user.click(
      screen.getByRole('button', { name: 'Propose removing this section, section 2' }),
    );
    expect(onRemove).toHaveBeenCalledWith(`${state.group ?? ''}.1`);
  });

  it('still offers removal beside Add your version, until the ballot holds a removal', () => {
    const log = groupLog();
    log.propose('ana', { atom: 0 });
    const second = log.propose('ana', { atom: 1, text: 'Bins go out on Monday.' });
    log.version('ben', second, '');
    view(log.state());
    expect(screen.getByRole('button', { name: 'Add your version to section 1' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Propose removing this section, section 1' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add your version to section 2' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Propose removing this section, section 2' }),
    ).toBeNull();
  });

  it('offers no Add or removal to someone who may not propose, but still Copy as Markdown', () => {
    const { state } = testGroup({ joiners: ['Ben'], levels: { Ben: VOTING } });
    view(state, authorOf('ben'));
    expect(screen.queryByRole('button', { name: /^Add a section/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Propose removing/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy as Markdown' })).toBeVisible();
  });

  it('copies the Document as Markdown, and politely says Copied', async () => {
    const user = userEvent.setup();
    const { state } = testGroup({ atoms: ['# Our aims\n', 'We meet monthly.\n'] });
    const copyText = vi.fn(() => Promise.resolve());
    view(state, authorOf('ana'), vi.fn(), { copyText });
    expect(
      screen.getByText(
        'To start a fresh group from this Document, copy it, then paste it into Create group.',
      ),
    ).toBeVisible();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('');
    await user.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    expect(copyText).toHaveBeenCalledWith('# Our aims\n\nWe meet monthly.\n');
    await waitFor(() => {
      expect(status).toHaveTextContent('Copied');
    });
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the Markdown selected in a read-only text area when copying is blocked', async () => {
    const user = userEvent.setup();
    const { state } = testGroup({ atoms: ['# Our aims\n', 'We meet monthly.\n'] });
    const copyText = vi.fn(() => Promise.reject(new Error('blocked')));
    view(state, authorOf('ana'), vi.fn(), { copyText });
    await user.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    const field = await screen.findByRole('textbox', { name: 'The Document as Markdown' });
    expect(field).toHaveValue('# Our aims\n\nWe meet monthly.\n');
    expect(field).toHaveAttribute('readonly');
    expect(field).toHaveFocus();
    const area = field as HTMLTextAreaElement;
    expect([area.selectionStart, area.selectionEnd]).toEqual([0, area.value.length]);
    expect(
      screen.getByText(
        'Copying is blocked here. The Document is selected below, so you can copy it yourself.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('status')).not.toHaveTextContent('Copied');
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no Propose or Add your version, and no level note, while the leave waits for the relay', async () => {
    const log = groupLog();
    log.propose('ana', { atom: 1 });
    view(log.state(), authorOf('ana'), vi.fn(), { leaving: true });
    expect(screen.getByText('Quiet hours start at ten.')).toBeVisible();
    // Copying is reading, and how someone who leaves carries the Document into a fresh group
    // (#75); so is each section's History (#104).
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'History',
      'History',
      'Copy as Markdown',
    ]);
    expect(screen.queryByText(/Choose Co-Creator|Choose Collaborator/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Change your involvement' })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});

describe('DocumentView: moving sections and headers (#103)', () => {
  it('offers Move this section on each section, and opens its composer for the one pressed', async () => {
    const user = userEvent.setup();
    const { state } = testGroup();
    const onMove = vi.fn();
    view(state, authorOf('ana'), vi.fn(), { onMove });
    const buttons = screen.getAllByRole('button', { name: /^Move this section/ });
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Move this section, section 1',
      'Move this section, section 2',
    ]);
    for (const button of buttons) {
      expect(button).toHaveTextContent('Move this section');
      expect(button).toBeEnabled();
    }
    await user.click(screen.getByRole('button', { name: 'Move this section, section 2' }));
    expect(onMove).toHaveBeenCalledWith(`${state.group ?? ''}.1`);
    expect(await axeViolations()).toEqual([]);
  });

  it('disables Move this section, and says why, while the section has an open Proposal', async () => {
    const user = userEvent.setup();
    const log = groupLog();
    log.propose('ana', { atom: 0 });
    const onMove = vi.fn();
    view(log.state(), authorOf('ana'), vi.fn(), { onMove });
    const busy = screen.getByRole('button', { name: 'Move this section, section 1' });
    expect(busy).toBeDisabled();
    const reason = screen.getByText('You can move this section once its open Proposal closes.');
    expect(reason).toBeVisible();
    expect(busy.getAttribute('aria-describedby')).toBe(reason.id);
    await user.click(busy);
    expect(onMove).not.toHaveBeenCalled();
    const free = screen.getByRole('button', { name: 'Move this section, section 2' });
    expect(free).toBeEnabled();
    expect(free).not.toHaveAttribute('aria-describedby');
    expect(screen.getAllByText(messages.document.moveBusy)).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });

  it('disables Move this section on a full ballot too, beside its note', () => {
    const log = groupLog();
    const proposal = log.propose('ana');
    log.version('ben', proposal, 'Quiet after midnight.');
    log.version('ben', proposal, 'Quiet after 10pm.');
    view(log.state());
    expect(screen.getByRole('button', { name: 'Move this section, section 1' })).toBeDisabled();
    expect(screen.getByText(messages.document.moveBusy)).toBeVisible();
  });

  it('says a section with an open move has one, and offers no change, version or removal on it', async () => {
    const log = groupLog();
    log.move('ana', `${log.group}.0`, `${log.group}.1`);
    view(log.state());
    expect(screen.getByText('This section has an open move.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Move this section, section 1' })).toBeDisabled();
    expect(
      screen
        .getAllByRole('button', { name: /section 1$/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Move this section, section 1',
      'History of section 1',
      'Add a section here, after section 1',
    ]);
    expect(screen.getByRole('button', { name: 'Propose a change to section 2' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no Move in a Document of one section, since there is nowhere to move it', () => {
    const { state } = testGroup({ atoms: ['Only this.\n'] });
    view(state);
    expect(screen.queryByRole('button', { name: /^Move this section/ })).not.toBeInTheDocument();
  });

  it('offers no Move to someone who may not propose', () => {
    const { state } = testGroup({ joiners: ['Ben'], levels: { Ben: VOTING } });
    view(state, authorOf('ben'));
    expect(screen.queryByRole('button', { name: /^Move this section/ })).not.toBeInTheDocument();
  });

  it('sets a heading-only section as a header, a section header at h2 and a subsection header at h3', async () => {
    const { state } = testGroup({
      atoms: [
        '# Values\n',
        'We care for each other.\n',
        '## Organization\n',
        '# Values\nWe care.\n',
      ],
    });
    const { container } = view(state);
    const atoms = Array.from(container.querySelectorAll('.document > .atom'));
    expect(atoms.map((atom) => atom.classList.contains('atom-heading'))).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(within(atoms[0] as HTMLElement).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Values',
    );
    expect(within(atoms[2] as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Organization',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('never skips a heading level, even when a subsection header comes first, keeping its look', async () => {
    const { state } = testGroup({
      atoms: ['## Organization\n', 'We meet weekly.\n', '# Values\n', '### Deep\n'],
    });
    const { container } = view(state);
    const headings = Array.from(container.querySelectorAll('.document h2, .document h3'));
    expect(headings.map((h) => [h.tagName, h.className, h.textContent])).toEqual([
      ['H2', 'atom-subheading', 'Organization'],
      ['H2', '', 'Values'],
      ['H3', 'atom-subheading', 'Deep'],
    ]);
    expect(await axeViolations()).toEqual([]);
  });

  it('offers Section, Section header and Subsection header from each Add a section here', async () => {
    const user = userEvent.setup();
    const { state } = testGroup();
    const onAdd = vi.fn();
    view(state, authorOf('ana'), vi.fn(), { onAdd });
    const gap = screen.getByRole('button', { name: 'Add a section here, after section 1' });
    expect(gap).toHaveAttribute('aria-haspopup');
    await user.click(gap);
    const menu = await screen.findByRole('menu', { name: 'Add a section here, after section 1' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Section', 'Section header', 'Subsection header']);
    expect(await axeViolations()).toEqual([]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Section header' }));
    await addVia(user, 'Add a section here, at the start', 'Subsection header');
    await addVia(user, 'Add a section here, after section 2', 'Section');
    const first = state.group ?? '';
    expect(onAdd.mock.calls).toEqual([
      [{ document: first, after: `${first}.0`, heading: 1 }],
      [{ document: first, after: null, heading: 2 }],
      [{ document: first, after: `${first}.1` }],
    ]);
  });
});

describe('DocumentView: several Documents (#92)', () => {
  const DOCUMENTS = [
    { title: 'Mission statement', atoms: ['We share.\n', 'We meet weekly.\n'] },
    { title: 'House rules', atoms: ['# Quiet\n', 'Quiet after 11pm.\n'] },
  ];

  it('links to the Document’s own change log, under its title (#104)', () => {
    const log = groupLog({ documents: DOCUMENTS });
    const second = `${log.group}:1`;
    view(log.state(), authorOf('ana'), vi.fn(), { documentId: second });
    const link = screen.getByRole('link', { name: messages.changeLog.link });
    expect(link).toHaveAttribute('href', `#/g/${log.group}/doc/${second}/log`);
    expect(link.closest('header')).not.toBeNull();
  });

  it('opens the Document its id names, its title and its sections alone, numbered from 1', async () => {
    const log = groupLog({ documents: DOCUMENTS });
    const second = `${log.group}:1`;
    const { container } = view(log.state(), authorOf('ana'), vi.fn(), { documentId: second });
    expect(screen.getByRole('heading', { level: 1, name: 'House rules' })).toBeVisible();
    const texts = Array.from(container.querySelectorAll('.atom-text'));
    expect(texts.map((node) => node.textContent)).toEqual(['Quiet', 'Quiet after 11pm.']);
    expect(
      screen.getAllByRole('button', { name: /^Propose a change/ }).map((b) => b.ariaLabel),
    ).toEqual(['Propose a change to section 1', 'Propose a change to section 2']);
    expect(await axeViolations()).toEqual([]);
  });

  it('opens the group’s first Document when the route names none', () => {
    const log = groupLog({ documents: DOCUMENTS });
    view(log.state());
    expect(screen.getByRole('heading', { level: 1, name: 'Mission statement' })).toBeVisible();
    expect(screen.queryByText('Quiet after 11pm.')).not.toBeInTheDocument();
  });

  it('says a Document isn’t in this group for an id it doesn’t have, with nothing to propose', async () => {
    const log = groupLog({ documents: DOCUMENTS });
    view(log.state(), authorOf('ana'), vi.fn(), { documentId: `${log.group}:2` });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This Document isn’t in this group' }),
    ).toBeVisible();
    expect(screen.getByText('Go back to your group to see its Documents.')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('adds, proposes and removes in the Document on screen, and copies it alone', async () => {
    const user = userEvent.setup();
    const log = groupLog({ documents: DOCUMENTS });
    const second = `${log.group}:1`;
    const onAdd = vi.fn();
    const onPropose = vi.fn();
    const onRemove = vi.fn();
    const copyText = vi.fn(() => Promise.resolve());
    const handlers = { documentId: second, onAdd, onRemove, copyText };
    view(log.state(), authorOf('ana'), onPropose, handlers);
    await addVia(user, 'Add a section here, at the start');
    await addVia(user, 'Add a section here, after section 2');
    expect(onAdd.mock.calls).toEqual([
      [{ document: second, after: null }],
      [{ document: second, after: `${second}.1` }],
    ]);
    await user.click(screen.getByRole('button', { name: 'Propose a change to section 1' }));
    expect(onPropose).toHaveBeenCalledWith(`${second}.0`);
    await user.click(
      screen.getByRole('button', { name: 'Propose removing this section, section 2' }),
    );
    expect(onRemove).toHaveBeenCalledWith(`${second}.1`);
    await user.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    expect(copyText).toHaveBeenCalledWith('# Quiet\n\nQuiet after 11pm.\n');
  });

  it('shows a new Document once its Proposal passes, under its own title', () => {
    const log = groupLog({ documents: DOCUMENTS });
    const created = log.newDocument('Ana', 'Budget', { text: '# Budget\n\nWe share costs.\n' });
    log.vote('Ana', created, 4);
    log.vote('Ben', created, 4);
    const { container } = view(log.state(), authorOf('ana'), vi.fn(), { documentId: created });
    expect(screen.getByRole('heading', { level: 1, name: 'Budget' })).toBeVisible();
    const texts = Array.from(container.querySelectorAll('.atom-text'));
    expect(texts.map((node) => node.textContent)).toEqual(['Budget', 'We share costs.']);
  });
});

describe('DocumentView: a suspended member (#102)', () => {
  it('tells them until when in place of the Propose buttons, with no level change to offer', async () => {
    const log = groupLog({ members: ['Kim'] });
    log.suspend('Ana', 'Kim', 'Threats.');
    view(log.state(), authorOf('kim'));
    expect(
      screen.getByText(
        /^A steward suspended you until .+\. You can read, but not post, propose or vote\.$/,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /Propose a change/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Change your involvement/ })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});

describe('CoalitionDocumentView (#120)', () => {
  const ATOMS: Atom[] = [
    { id: 'c.0', documentId: 'c', text: 'We keep the river clean.' },
    { id: 'c.1', documentId: 'c', text: 'We meet on the first Sunday.' },
  ];

  /** The coalition's Document as someone standing `standing` reads it. */
  function coalitionView(standing: CoalitionStanding, open = new Set<string>(), atoms = ATOMS) {
    const onPropose = vi.fn();
    const onTakePart = vi.fn(() => Promise.resolve());
    render(
      <CoalitionDocumentView
        coalitionId="c"
        name="Eastside Housing"
        documentId="c"
        title="Mission statement"
        atoms={atoms}
        standing={standing}
        open={open}
        onPropose={onPropose}
        onTakePart={onTakePart}
        copyText={vi.fn(() => Promise.resolve())}
        history={{
          historyOf: () => ({ passed: [], notPassed: [] }),
          names: { members: [], former: [] },
          resultHref: () => null,
        }}
      />,
    );
    return { onPropose, onTakePart };
  }

  it('offers each section’s History and the change log to everyone who reads it (#104)', () => {
    for (const standing of [
      { kind: 'proposes', groupId: 'g' },
      { kind: 'reads' },
    ] as const satisfies readonly CoalitionStanding[]) {
      coalitionView(standing, new Set(['c.0']));
      expect(screen.getByRole('button', { name: messages.history.openLabel(1) })).toBeVisible();
      expect(screen.getByRole('button', { name: messages.history.openLabel(2) })).toBeVisible();
      expect(screen.getByRole('link', { name: messages.changeLog.link })).toHaveAttribute(
        'href',
        '#/c/c/doc/c/log',
      );
      cleanup();
    }
  });

  it('offers Propose a change on each section to whoever proposes, and only that', async () => {
    const user = userEvent.setup();
    const { onPropose } = coalitionView({ kind: 'proposes', groupId: 'g' });

    expect(screen.getByRole('heading', { level: 1, name: 'Mission statement' })).toBeVisible();
    expect(screen.getByText(messages.coalitions.documentEyebrow)).toBeVisible();
    expect(screen.getByRole('link', { name: /Eastside Housing/ })).toHaveAttribute('href', '#/c/c');
    await user.click(screen.getByRole('button', { name: 'Propose a change to section 2' }));
    expect(onPropose).toHaveBeenCalledWith('c.1');
    // A coalition motion only rewords a section (#100): no add, removal or version here.
    expect(
      screen.queryByRole('button', { name: /Add a section|removing|Add your version/ }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy as Markdown' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says a section with a motion open takes none until it’s decided', () => {
    coalitionView({ kind: 'proposes', groupId: 'g' }, new Set(['c.0']));
    expect(screen.getAllByRole('button', { name: /Propose a change/ })).toHaveLength(1);
    expect(screen.getByText(messages.coalitions.sectionOpen)).toBeVisible();
  });

  it('shows a reader no Propose, and why', () => {
    coalitionView({ kind: 'reads' });
    expect(screen.queryByRole('button', { name: /Propose/ })).toBeNull();
    expect(screen.getByText(messages.coalitions.cantPropose)).toBeVisible();
  });

  it('says joining while a join waits', () => {
    coalitionView({ kind: 'joining' });
    expect(screen.queryByRole('button', { name: /Propose/ })).toBeNull();
    expect(screen.getByText(messages.coalitions.joining)).toBeVisible();
  });

  it('offers Take part first to someone who may propose in a member group', async () => {
    const user = userEvent.setup();
    const { onTakePart } = coalitionView({ kind: 'take-part', groupId: 'g' });
    expect(screen.queryByRole('button', { name: /Propose a change/ })).toBeNull();
    expect(screen.getByText(messages.coalitions.takePartFirst)).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Your name in the coalition' }), 'Cy');
    await user.click(screen.getByRole('button', { name: 'Take part' }));
    expect(onTakePart).toHaveBeenCalledWith('Cy');
  });

  it('says an empty Document has no sections, with nothing to copy', () => {
    coalitionView({ kind: 'proposes', groupId: 'g' }, new Set(), []);
    expect(screen.getByText(messages.document.empty)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Copy as Markdown' })).toBeNull();
  });
});
