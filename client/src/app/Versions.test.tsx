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

  it('keeps a right-to-left name from reordering the heading', () => {
    show(CURRENT, [{ id: 'v1', number: 1, author: 'שרה', text: 'x\n' }]);
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.querySelector('bdi')).toHaveTextContent('שרה');
  });
});
