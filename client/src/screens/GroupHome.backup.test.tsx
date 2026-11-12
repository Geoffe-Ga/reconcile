/**
 * Group home's slots for the backup card (#78) and the recovery card (#109):
 * right after the open Proposals, ahead of the focus when it would follow them
 * (#107), and before the Document.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MINUTE_MS } from '../app/time';
import { testGroup } from '../test/groups';
import { authorOf } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
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
      onVouch={vi.fn(() => Promise.resolve())}
      {...props}
    />,
  );
}

describe('GroupHome', () => {
  it('shows the backup card it’s given between the open Proposals and the Document', () => {
    renderHome({ backupCard: <p>The backup card</p> });

    const card = screen.getByText('The backup card');
    const open = screen.getByRole('region', { name: 'Open Proposals' });
    const documentSection = screen.getByRole('region', { name: 'Documents' });
    expect(open.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      card.compareDocumentPosition(documentSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps the card under Needs your vote, ahead of the focus (#107), when nothing else is open', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    log.propose('ben', { title: 'Later quiet hours' });
    renderHome({ state: log.state(), backupCard: <p>The backup card</p> });

    const card = screen.getByText('The backup card');
    const waits = screen.getByRole('region', { name: 'Needs your vote' });
    const focus = screen.getByRole('region', { name: 'Focus' });
    expect(screen.queryByRole('region', { name: /Open Proposals/ })).toBeNull();
    expect(waits.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(focus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows none without one', () => {
    renderHome();

    expect(screen.queryByText('The backup card')).not.toBeInTheDocument();
  });

  it('shows the recovery card it’s given after the backup card, before the Document (#109)', () => {
    renderHome({ backupCard: <p>The backup card</p>, recoveryCard: <p>The recovery card</p> });

    const backup = screen.getByText('The backup card');
    const recovery = screen.getByText('The recovery card');
    const documentSection = screen.getByRole('region', { name: 'Document' });
    expect(
      backup.compareDocumentPosition(recovery) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      recovery.compareDocumentPosition(documentSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows no recovery card once the group has dissolved (#108, #109)', () => {
    const { state } = testGroup();
    renderHome({
      state: { ...state, dissolved: { received: START_MINUTE, wipe: false } },
      recoveryCard: <p>The recovery card</p>,
    });

    expect(screen.queryByText('The recovery card')).not.toBeInTheDocument();
  });
});
