import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { formatDay } from '../app/format';
import { messages } from '../app/messages';
import { closeTime, type GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { groupLog, type LogBuilder } from '../test/votes';
import { GroupChangeLog } from './ChangeLog';

const VOTERS = ['Ana', 'Ben', 'Cal'];

/** Each voter scores `proposal` `score`, a minute apart, which closes it early. */
function everyone(log: LogBuilder, proposal: string, score: 0 | 4) {
  for (const voter of VOTERS) {
    log.minute += 1;
    log.vote(voter, proposal, score, score === 0 ? 'Not this.' : undefined);
  }
}

/**
 * House rules and Budget. In House rules, Quiet hours passes, Guests adds a section, No bins
 * removes section 2, and Never fails; in Budget, Receipts passes.
 */
function changes() {
  const log = groupLog({
    members: ['Ben', 'Cal'],
    documents: [
      { title: 'House rules', atoms: ['Quiet hours start at ten.', 'Bins go out on Tuesday.'] },
      { title: 'Budget', atoms: ['We share costs.'] },
    ],
  });
  const { group } = log;
  const quiet = log.propose('Ana', { title: 'Quiet hours', text: 'Quiet after 10pm.\n' });
  everyone(log, quiet, 4);
  log.minute += 5;
  const guests = log.addSection('Ben', `${group}.0`, { title: 'Guests' });
  everyone(log, guests, 4);
  log.minute += 5;
  const bins = log.propose('Cal', { atom: 1, title: 'No bins rule', text: '' });
  everyone(log, bins, 4);
  log.minute += 5;
  const never = log.propose('Ben', { atomId: guests, title: 'Never', text: 'Never.\n' });
  everyone(log, never, 0);
  log.minute += 5;
  const receipts = log.propose('Ana', { atomId: `${group}:1.0`, title: 'Receipts', text: 'R.\n' });
  everyone(log, receipts, 4);
  return { state: log.state(log.minute + 1), group, ids: { quiet, guests, bins } };
}

/** The change log of `documentId` in `state`. */
function changeLog(state: GroupState, documentId: string) {
  return render(<GroupChangeLog state={state} documentId={documentId} />);
}

/** The log's rows, newest first. */
function rows(): HTMLElement[] {
  return within(screen.getByRole('list', { name: messages.changeLog.eyebrow })).getAllByRole(
    'listitem',
  );
}

describe('GroupChangeLog', () => {
  it('lists every passed change in the Document, newest first, with its date, ending with its founding', async () => {
    const { state, group, ids } = changes();
    changeLog(state, group);
    expect(screen.getByRole('heading', { level: 1, name: 'House rules' })).toBeVisible();
    expect(screen.getByText(messages.changeLog.eyebrow, { selector: '.eyebrow' })).toBeVisible();
    expect(screen.getByRole('link', { name: /House rules/ })).toHaveAttribute(
      'href',
      `#/g/${group}/doc/${group}`,
    );
    expect(document.title).toBe('Change log · Reconcile');
    expect(screen.getByText(messages.changeLog.lede)).toBeVisible();
    const day = (id: string) => {
      const proposal = state.proposals.find((p) => p.id === id);
      return proposal === undefined ? '' : formatDay(closeTime(proposal));
    };
    expect(rows().map((row) => row.textContent)).toEqual([
      `No bins rule${messages.changeLog.removed('Bins go out on Tuesday.')}${day(ids.bins)}`,
      `Guests${messages.changeLog.added}${day(ids.guests)}`,
      `Quiet hours${messages.changeLog.changed('Quiet hours start at ten.')}${day(ids.quiet)}`,
      `${messages.changeLog.founded}${formatDay(state.founding?.received ?? 0)}`,
    ]);
    expect(screen.queryByText(/Receipts|Never/)).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('opens each change’s section history from its row, a removed section’s included, and gives focus back', async () => {
    const user = userEvent.setup();
    const { state, group } = changes();
    changeLog(state, group);
    const [removed, added, changed, founded] = rows();
    if (removed === undefined || added === undefined || changed === undefined) throw new Error();
    const opener = within(removed).getByRole('button');
    await user.click(opener);
    const sheet = screen.getByRole('dialog', { name: messages.history.removedTitle });
    expect(sheet).toHaveTextContent(messages.history.removed);
    expect(await axeViolations()).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
    // Guests sits second now, after Quiet hours.
    await user.click(within(added).getByRole('button'));
    expect(screen.getByRole('dialog', { name: messages.history.title(2) })).toBeVisible();
    await user.keyboard('{Escape}');
    await user.click(within(changed).getByRole('button'));
    expect(screen.getByRole('dialog', { name: messages.history.title(1) })).toBeVisible();
    await user.keyboard('{Escape}');
    // The founding text made every first section at once: it opens no one section's history.
    expect(founded === undefined ? null : within(founded).queryByRole('button')).toBeNull();
  });

  it('says nothing has changed a Document since it began', () => {
    const fresh = groupLog({ members: ['Ben'] });
    changeLog(fresh.state(), fresh.group);
    expect(screen.getByText(messages.changeLog.unchanged)).toBeVisible();
    expect(screen.queryByText(messages.changeLog.lede)).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it('starts a new Document’s log with the Proposal that started it', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const budget = log.newDocument('Cal', 'Budget', { title: 'Start a budget' });
    everyone(log, budget, 4);
    changeLog(log.state(log.minute + 1), budget);
    expect(screen.getByRole('heading', { level: 1, name: 'Budget' })).toBeVisible();
    const [started] = rows();
    expect(started).toHaveTextContent(`Start a budget${messages.changeLog.created}`);
    expect(started === undefined ? null : within(started).queryByRole('button')).toBeNull();
  });

  it('says a Document the group doesn’t have isn’t in it', () => {
    const log = groupLog();
    changeLog(log.state(), 'nope');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      messages.documents.missingTitle,
    );
  });
});
