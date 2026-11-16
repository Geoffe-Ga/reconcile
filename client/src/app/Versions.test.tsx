import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { axeViolations } from '../test/axe';
import { groupLog } from '../test/votes';
import { VersionList } from './Versions';
import { type VersionView, versionViews } from './versionViews';

const CURRENT = 'Quiet hours start at ten.\n';

const VERSIONS: readonly VersionView[] = [
  { id: 'v1', number: 1, author: 'Ana', text: 'Quiet hours start at eleven.\n' },
  { id: 'v2', number: 2, author: 'Ben', text: 'Quiet hours start at midnight.\n' },
];

function show(current: string | null, versions: readonly VersionView[] = VERSIONS) {
  document.title = 'Proposal · Reconcile';
  render(
    <main>
      <h1>Proposal</h1>
      <h2>Changes</h2>
      <VersionList versions={versions} current={current}>
        {(version) => <p>{`Pills for ${version.id}`}</p>}
      </VersionList>
    </main>,
  );
}

describe('versionViews', () => {
  it('numbers a Proposal’s versions in relay order, each with its author’s name', () => {
    const log = groupLog({ members: ['Ben'] });
    const proposal = log.propose('Ana', { text: 'Quiet after 11pm.\n' });
    const second = log.version('Ben', proposal, 'Quiet after midnight.\n');
    const state = log.state();
    const folded = state.proposals[0];
    if (folded === undefined) throw new Error('Expected the Proposal.');
    expect(versionViews(state, folded)).toEqual([
      { id: proposal, number: 1, author: 'Ana', text: 'Quiet after 11pm.\n' },
      { id: second, number: 2, author: 'Ben', text: 'Quiet after midnight.\n' },
    ]);
  });

  it('says first what each version of an add does, and what a removal does', () => {
    const log = groupLog({ members: ['Ben'] });
    const after = log.addSection('Ana', `${log.group}.0`);
    const first = log.addSection('Ben', null, { text: '# House rules\n' });
    const edit = log.propose('Ana', { atom: 1, text: 'Bins go out on Monday.\n' });
    const removal = log.version('Ben', edit, '');
    const state = log.state();
    const views = (id: string) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (proposal === undefined) throw new Error('Expected the Proposal.');
      return versionViews(state, proposal);
    };
    expect(views(after)).toEqual([
      {
        id: after,
        number: 1,
        author: 'Ana',
        text: 'Guests leave by 11pm.\n',
        does: 'Adds a section after ‘Quiet hours start at ten.’',
      },
    ]);
    expect(views(first).map((view) => view.does)).toEqual([
      'Adds a section header ‘House rules’ at the start',
    ]);
    expect(views(edit)).toEqual([
      { id: edit, number: 1, author: 'Ana', text: 'Bins go out on Monday.\n' },
      { id: removal, number: 2, author: 'Ben', text: '', does: 'Removes this section' },
    ]);
  });

  it('says nothing of sections on a steward ballot, whose one version has no text (#102)', () => {
    const log = groupLog({ members: ['Ben', 'Cy'] });
    const election = log.steward('Ana', 1, 'Ben');
    const state = log.state();
    const proposal = state.proposals.find((candidate) => candidate.id === election);
    if (proposal === undefined) throw new Error('Expected the steward Proposal.');
    const [view] = versionViews(state, proposal);
    expect(view?.text).toBe('');
    expect(view?.does).toBeUndefined();
    expect(view?.steward).toBeDefined();
  });

  it('says a header add adds a section header, or a subsection header, and where (#103)', () => {
    const log = groupLog({ members: ['Ben'] });
    const header = log.addSection('Ana', `${log.group}.0`, { text: '# Values\n' });
    const sub = log.addSection('Ben', null, { text: '## Organization\n' });
    const deep = log.addSection('Ben', `${log.group}.1`, { text: '### Meetings\n' });
    const prose = log.addSection('Ana', `${log.group}.1`, { text: '# Values\nWe care.\n' });
    const state = log.state();
    const does = (id: string) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (proposal === undefined) throw new Error('Expected the add.');
      return versionViews(state, proposal).map((view) => view.does);
    };
    expect(does(header)).toEqual([
      'Adds a section header ‘Values’ after ‘Quiet hours start at ten.’',
    ]);
    expect(does(sub)).toEqual(['Adds a subsection header ‘Organization’ at the start']);
    expect(does(deep)).toEqual([
      'Adds a subsection header ‘Meetings’ after ‘Bins go out on Tuesday.’',
    ]);
    expect(does(prose)).toEqual(['Adds a section after ‘Bins go out on Tuesday.’']);
  });

  it('says a header add whose anchor has gone goes at the end (#103)', () => {
    const log = groupLog({ members: ['Ben'] });
    const add = log.addSection('Ana', `${log.group}.0`, { text: '# Values\n' });
    const removal = log.propose('Ben', { atom: 0, text: '' });
    log.vote('Ana', removal, 4);
    log.vote('Ben', removal, 4);
    const state = log.state();
    const proposal = state.proposals.find((candidate) => candidate.id === add);
    if (proposal === undefined) throw new Error('Expected the add.');
    expect(versionViews(state, proposal).map((view) => view.does)).toEqual([
      'Adds a section header ‘Values’ at the end',
    ]);
  });

  it('shows a move as its one card: where it moves the section, over the section’s text (#103)', () => {
    const log = groupLog({ members: ['Ben'] });
    const after = log.move('Ana', `${log.group}.0`, `${log.group}.1`);
    const first = log.move('Ben', `${log.group}.1`, null);
    const state = log.state();
    const views = (id: string) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (proposal === undefined) throw new Error('Expected the move.');
      return versionViews(state, proposal);
    };
    expect(views(after)).toEqual([
      {
        id: after,
        number: 1,
        author: 'Ana',
        text: '',
        move: {
          line: 'Moves this section after ‘Bins go out on Tuesday.’',
          text: 'Quiet hours start at ten.',
        },
      },
    ]);
    expect(views(first).map((view) => view.move)).toEqual([
      { line: 'Moves this section to the start', text: 'Bins go out on Tuesday.' },
    ]);
  });

  it('says a move whose anchor has gone goes to the end, and shows no text once its section has gone (#103)', () => {
    const log = groupLog({ members: ['Ben'] });
    const move = log.move('Ana', `${log.group}.0`, `${log.group}.1`);
    const removal = log.propose('Ben', { atom: 1, text: '' });
    log.vote('Ana', removal, 4);
    log.vote('Ben', removal, 4);
    const moving = log.state().proposals.find((candidate) => candidate.id === move);
    if (moving === undefined) throw new Error('Expected the move.');
    expect(versionViews(log.state(), moving)[0]?.move?.line).toBe('Moves this section to the end');
    log.vote('Ana', move, 4);
    log.vote('Ben', move, 4);
    const gone = log.propose('Ana', { atom: 0, text: '' });
    log.vote('Ana', gone, 4);
    log.vote('Ben', gone, 4);
    const state = log.state();
    const moved = state.proposals.find((candidate) => candidate.id === move);
    if (moved === undefined) throw new Error('Expected the move.');
    expect(versionViews(state, moved)[0]?.move).toEqual({
      line: 'Moves this section to the end',
      text: null,
    });
  });

  it('says an add whose anchor has been removed goes at the end', () => {
    const log = groupLog({ members: ['Ben'] });
    const add = log.addSection('Ana', `${log.group}.0`);
    const removal = log.propose('Ben', { atom: 0, text: '' });
    log.vote('Ana', removal, 4);
    log.vote('Ben', removal, 4);
    const state = log.state();
    const proposal = state.proposals.find((candidate) => candidate.id === add);
    if (proposal === undefined) throw new Error('Expected the add.');
    expect(state.atoms.map((atom) => atom.id)).toEqual([`${log.group}.1`]);
    expect(versionViews(state, proposal).map((view) => view.does)).toEqual([
      'Adds a section at the end',
    ]);
  });
});

describe('VersionList', () => {
  it('shows each version under “Version N · name”, as a word diff, with what goes under it', async () => {
    show(CURRENT);
    expect(screen.getAllByRole('region')).toHaveLength(2);
    const first = screen.getByRole('region', { name: 'Version 1 · Ana' });
    expect(within(first).getByRole('heading', { level: 3 })).toHaveTextContent('Version 1 · Ana');
    expect(first.querySelector('ins')).toHaveTextContent(/^eleven$/);
    expect(first.querySelector('del')).toHaveTextContent(/^ten$/);
    expect(within(first).getByText('Pills for v1')).toBeVisible();
    const second = screen.getByRole('region', { name: 'Version 2 · Ben' });
    expect(second.querySelector('ins')).toHaveTextContent(/^midnight$/);
    expect(within(second).getByText('Pills for v2')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('opens each version’s “How it will read” on its own', async () => {
    show(CURRENT);
    const user = userEvent.setup();
    const first = screen.getByRole('region', { name: 'Version 1 · Ana' });
    const toggle = within(first).getByRole('button', { name: 'How it will read' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(first).getByText('Quiet hours start at eleven.')).toBeVisible();
    const second = screen.getByRole('region', { name: 'Version 2 · Ben' });
    expect(within(second).getByRole('button', { name: 'How it will read' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('shows each text as it reads, with no diff, when there is no current text to compare', () => {
    show(null);
    const first = screen.getByRole('region', { name: 'Version 1 · Ana' });
    expect(first.querySelector('.word-diff')).toBeNull();
    expect(within(first).getByText('Quiet hours start at eleven.')).toBeVisible();
    expect(within(first).queryByRole('button')).not.toBeInTheDocument();
  });

  it('marks how many versions there are, so wide screens set them in equal columns', () => {
    show(CURRENT);
    expect(document.querySelector('.versions')).toHaveClass('versions-2');
  });

  it('says what a removal does, then strikes the whole section through, with nothing to read', async () => {
    show(CURRENT, [
      { id: 'v1', number: 1, author: 'Ana', text: 'Quiet hours start at eleven.\n' },
      { id: 'v2', number: 2, author: 'Ben', text: '', does: 'Removes this section' },
    ]);
    const removal = screen.getByRole('region', { name: 'Version 2 · Ben' });
    const [does, diff] = Array.from(removal.querySelectorAll('h3 ~ *'));
    expect(does).toHaveTextContent('Removes this section');
    expect(diff?.querySelector('del')).toHaveTextContent('Quiet hours start at ten.');
    expect(diff?.querySelector('ins')).toBeNull();
    expect(within(removal).queryByRole('button', { name: 'How it will read' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('says where an add goes, then marks its whole text as added, and how it will read', async () => {
    const adds = { does: 'Adds a section at the start' };
    show('', [{ id: 'v1', number: 1, author: 'Ana', text: '# House rules\n', ...adds }]);
    const version = screen.getByRole('region', { name: 'Version 1 · Ana' });
    expect(within(version).getByText('Adds a section at the start')).toBeVisible();
    expect(version.querySelector('.word-diff ins')).toHaveTextContent('# House rules');
    expect(version.querySelector('.word-diff del')).toBeNull();
    expect(within(version).getByRole('button', { name: 'How it will read' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('heads a move’s one card with where it moves the section, over the section as it reads (#103)', async () => {
    const move = { line: 'Moves this section to the start', text: '## Organization\n' };
    show(null, [{ id: 'v1', number: 1, author: 'Ana', text: '', move }]);
    const card = screen.getByRole('region', { name: 'Moves this section to the start' });
    expect(within(card).queryByText(/Version 1/)).toBeNull();
    expect(within(card).getByRole('heading', { level: 3, name: 'Organization' })).toBeVisible();
    expect(card.querySelector('.atom-card')).toHaveTextContent('Organization');
    expect(within(card).queryByRole('button', { name: 'How it will read' })).toBeNull();
    expect(within(card).getByText('Pills for v1')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows a move’s card with no text once its section has gone (#103)', () => {
    const move = { line: 'Moves this section to the end', text: null };
    show(null, [{ id: 'v1', number: 1, author: 'Ana', text: '', move }]);
    const card = screen.getByRole('region', { name: 'Moves this section to the end' });
    expect(card.querySelector('.atom-card')).toBeNull();
  });

  it('keeps a right-to-left name from reordering the heading', () => {
    show(CURRENT, [{ id: 'v1', number: 1, author: 'שרה', text: 'x\n' }]);
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.querySelector('bdi')).toHaveTextContent('שרה');
  });
});
