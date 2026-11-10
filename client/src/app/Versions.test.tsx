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
    expect(views(first).map((view) => view.does)).toEqual(['Adds a section at the start']);
    expect(views(edit)).toEqual([
      { id: edit, number: 1, author: 'Ana', text: 'Bins go out on Monday.\n' },
      { id: removal, number: 2, author: 'Ben', text: '', does: 'Removes this section' },
    ]);
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

  it('keeps a right-to-left name from reordering the heading', () => {
    show(CURRENT, [{ id: 'v1', number: 1, author: 'שרה', text: 'x\n' }]);
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.querySelector('bdi')).toHaveTextContent('שרה');
  });
});
