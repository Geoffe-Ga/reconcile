/** Group home's slot for the backup card (#78): after the open Proposals, before the Document. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MINUTE_MS } from '../app/time';
import { testGroup } from '../test/groups';
import { authorOf } from '../test/keys';
import { START_MINUTE } from '../test/votes';
import { GroupHome, type GroupHomeProps } from './GroupHome';

const NOW = START_MINUTE + 60;

function renderHome(props: Partial<GroupHomeProps> = {}) {
  const { state } = testGroup();
  render(
    <GroupHome
      state={state}
      me={authorOf('ana')}
      makeInviteLink={vi.fn(() => Promise.resolve('https://reconcile.test/'))}
      copyText={vi.fn(() => Promise.resolve())}
      now={NOW}
      sync={{
        reachable: true,
        lastSyncAt: NOW * MINUTE_MS,
        deviceNow: NOW * MINUTE_MS,
        missingHistory: false,
      }}
      pending={[]}
      onChooseLevel={vi.fn(() => Promise.resolve())}
      onSuspend={vi.fn(() => Promise.resolve())}
      onLeave={vi.fn(() => Promise.resolve())}
      {...props}
    />,
  );
}

describe('GroupHome', () => {
  it('shows the backup card it’s given between the open Proposals and the Document', () => {
    renderHome({ backupCard: <p>The backup card</p> });

    const card = screen.getByText('The backup card');
    const open = screen.getByRole('region', { name: 'Open Proposals' });
    const documentSection = screen.getByRole('region', { name: 'Document' });
    expect(open.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      card.compareDocumentPosition(documentSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows none without one', () => {
    renderHome();

    expect(screen.queryByText('The backup card')).not.toBeInTheDocument();
  });
});
