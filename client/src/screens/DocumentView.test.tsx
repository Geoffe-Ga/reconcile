import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { testGroup } from '../test/groups';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { DocumentView } from './DocumentView';

const [FOLLOWING, VOTING] = LEVELS;

/** What the Document view reports, and its clipboard. */
interface Handlers {
  readonly onPropose?: (atomId: string) => void;
  readonly onAdd?: (after: string | null) => void;
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
      copyText={handlers.copyText ?? vi.fn(() => Promise.resolve())}
    />,
  );
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

  it('says a section’s ballot is full once it holds three versions, with no button', async () => {
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
      'Add a section here, after section 1',
      'Propose a change to section 2',
      'Propose removing this section, section 2',
      'Add a section here, after section 2',
    ]);
    expect(await axeViolations()).toEqual([]);
  });

  it('says so when the Document has no sections, and offers a first one', async () => {
    const user = userEvent.setup();
    const { state } = testGroup({ atoms: [] });
    const onAdd = vi.fn();
    view(state, authorOf('ana'), vi.fn(), { onAdd });
    expect(screen.getByText('This Document has no sections yet.')).toBeVisible();
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Add a section here, at the start']);
    expect(screen.queryByRole('button', { name: 'Copy as Markdown' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a section here, at the start' }));
    expect(onAdd).toHaveBeenCalledWith(null);
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
    await user.click(gaps[0] ?? document.body);
    await user.click(gaps[2] ?? document.body);
    expect(onAdd.mock.calls).toEqual([[null], [`${state.group ?? ''}.1`]]);
    expect(await axeViolations()).toEqual([]);
  });

  it('names every button with its visible words first, so speaking them presses it (WCAG 2.5.3)', () => {
    const log = groupLog();
    log.propose('ana');
    view(log.state());
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(8);
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
