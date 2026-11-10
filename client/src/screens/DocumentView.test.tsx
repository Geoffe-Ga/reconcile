import { render, screen, within } from '@testing-library/react';
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

/** The Document view as `me` (default: the founder, Ana, a Co-Creator) sees it. */
function view(state: GroupState, me = authorOf('ana'), onPropose = vi.fn()) {
  return render(<DocumentView state={state} me={me} onPropose={onPropose} />);
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
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Propose a change to section 2']);
    expect(await axeViolations()).toEqual([]);
  });

  it('says so when the Document has no sections', async () => {
    const { state } = testGroup({ atoms: [] });
    view(state);
    expect(screen.getByText('This Document has no sections yet.')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});
