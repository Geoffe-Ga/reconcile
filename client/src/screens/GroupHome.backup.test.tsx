/**
 * Group home's slot for the backup card (#78): right after the open Proposals, ahead of the focus
 * when it would follow them (#107), and before the Document; none once the group's key changed
 * past this device (#226).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BackupCard } from '../app/BackupCard';
import { messages } from '../app/messages';
import { MINUTE_MS } from '../app/time';
import { axeViolations } from '../test/axe';
import { testGroup } from '../test/groups';
import { authorOf } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
import { GroupHome, type GroupHomeProps } from './GroupHome';

const NOW = START_MINUTE + 60;

const SYNCED = {
  reachable: true,
  lastSyncAt: NOW * MINUTE_MS,
  deviceNow: NOW * MINUTE_MS,
  missingHistory: false,
};

function home(props: Partial<GroupHomeProps> = {}) {
  const { state } = testGroup();
  return (
    <GroupHome
      state={state}
      me={authorOf('ana')}
      makeInviteLink={vi.fn(() => Promise.resolve('https://reconcile.test/'))}
      copyText={vi.fn(() => Promise.resolve())}
      now={NOW}
      sync={SYNCED}
      pending={[]}
      onChooseLevel={vi.fn(() => Promise.resolve())}
      onSuspend={vi.fn(() => Promise.resolve())}
      onLeave={vi.fn(() => Promise.resolve())}
      onVouch={vi.fn(() => Promise.resolve())}
      {...props}
    />
  );
}

function renderHome(props: Partial<GroupHomeProps> = {}) {
  return render(home(props));
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

  it.each([
    ['missed', messages.home.keyMissed],
    ['left', messages.home.keyLeft],
  ] as const)(
    'hides the card once the group’s key changed past this device (%s), and shows it again once it reads on (#226)',
    async (keyChange, line) => {
      const backupCard = <BackupCard onNotNow={vi.fn(() => Promise.resolve())} />;
      const { rerender } = renderHome({ sync: { ...SYNCED, keyChange }, backupCard });

      expect(screen.getByText(line)).toBeVisible();
      expect(screen.queryByText(messages.backupCard.body)).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Save a backup' })).not.toBeInTheDocument();
      expect(await axeViolations()).toEqual([]);

      rerender(home({ sync: { ...SYNCED, keyChange: null }, backupCard }));
      expect(screen.queryByText(line)).not.toBeInTheDocument();
      expect(screen.getByText(messages.backupCard.body)).toBeVisible();
      expect(screen.getByRole('link', { name: 'Save a backup' })).toBeVisible();
    },
  );
});
