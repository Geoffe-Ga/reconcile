import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from 'react-aria-components';
import { describe, expect, it, vi } from 'vitest';

import { formatDay } from '../app/format';
import { groupHistory, type HistorySource } from '../app/historySource';
import { messages } from '../app/messages';
import { LEVELS } from '../engine/capabilities';
import { parseRecord } from '../engine/event';
import { expiringProposal, resultFor } from '../engine/expiry';
import { closeTime, fold, type GroupState } from '../engine/fold';
import { sectionHistory } from '../engine/history';
import { axeViolations } from '../test/axe';
import { foldLogs, folded, Logs } from '../test/coalitions';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog, type LogBuilder } from '../test/votes';
import { DocumentView } from './DocumentView';
import { HistorySheet } from './SectionHistory';

const [FOLLOWING] = LEVELS;

/** Ana and Ben write; Zed and Yan, whose names are canaries, only ever vote. */
const VOTERS = ['Ana', 'Ben', 'Zed Canary', 'Yan Canary'];

/** Each voter scores `proposal`'s versions as `scores` gives, a minute apart, which closes it early. */
function everyone(log: LogBuilder, proposal: string, scores: Record<string, 0 | 1 | 2 | 3 | 4>) {
  for (const voter of VOTERS) {
    log.minute += 1;
    const zero = Object.values(scores).includes(0);
    log.ballot(voter, proposal, scores, zero ? `${voter} says no, canary note.` : undefined);
  }
}

/**
 * Section 1 of House rules: founded by Ana; Quiet hours passes on Ana's text; No quiet hours
 * fails; Quiet at nine lapses; then Quiet at midnight passes on Ben's version.
 */
function story() {
  const log = groupLog({ members: VOTERS.slice(1) });
  const quiet = log.propose('Ana', {
    title: 'Quiet hours',
    why: 'We sleep early.',
    text: 'Quiet after 10pm.\n',
  });
  everyone(log, quiet, { [quiet]: 4 });
  log.minute += 10;
  const none = log.propose('Ben', { title: 'No quiet hours', why: 'Adults.', text: 'Noise.\n' });
  everyone(log, none, { [none]: 0 });
  log.minute += 10;
  const nine = log.propose('Ben', { title: 'Quiet at nine', why: 'Kids.', text: 'Nine.\n' });
  log.minute = deadlineOf(log.minute) + 5;
  const midnight = log.propose('Ana', {
    title: 'Quiet at midnight',
    why: 'Summer nights.',
    text: 'Quiet after midnight.\n',
  });
  log.minute += 1;
  const bens = log.version('Ben', midnight, 'Quiet after *11pm* on weekdays.\n');
  everyone(log, midnight, { [midnight]: 2, [bens]: 4 });
  log.minute += 1;
  return { log, state: log.state(), ids: { quiet, none, nine, midnight } };
}

/** The Document view of `state`, as Ana, a Co-Creator, reads it. */
function documentView(state: GroupState, me = authorOf('ana')) {
  return render(
    <DocumentView
      state={state}
      me={me}
      onPropose={vi.fn()}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onMove={vi.fn()}
      onProtect={vi.fn()}
      copyText={vi.fn(() => Promise.resolve())}
    />,
  );
}

/** The sheet's entries, newest first. */
function entriesOf(sheet: HTMLElement): HTMLElement[] {
  return Array.from(sheet.querySelectorAll<HTMLElement>('.history-entry'));
}

/** Opens section `section`'s History sheet and returns it. */
async function openHistory(user: ReturnType<typeof userEvent.setup>, section: number) {
  await user.click(screen.getByRole('button', { name: messages.history.openLabel(section) }));
  return screen.getByRole('dialog', { name: messages.history.title(section) });
}

describe('SectionHistory', () => {
  it('opens from a section’s History, takes focus, and gives it back to History on Close and on Escape', async () => {
    const user = userEvent.setup();
    const { state } = story();
    documentView(state);
    const opener = screen.getByRole('button', { name: messages.history.openLabel(1) });

    const sheet = await openHistory(user, 1);
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
    await user.click(within(sheet).getByRole('button', { name: messages.history.close }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // React Aria gives focus back on the next frame, once the sheet has gone.
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });

    const again = await openHistory(user, 1);
    expect(again).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('shows each pass, newest first, with its text, who proposed it, when, why and its totals, then the founding text', async () => {
    const user = userEvent.setup();
    const { state, ids } = story();
    documentView(state);
    const sheet = await openHistory(user, 1);
    const entries = entriesOf(sheet);
    expect(
      entries.map((entry) => within(entry).getByRole('heading', { level: 3 }).textContent),
    ).toEqual(['Quiet at midnight', 'Quiet hours', messages.history.founding]);
    const [midnight, quiet, founding] = entries;
    if (midnight === undefined || quiet === undefined || founding === undefined) throw new Error();
    // The winning text, through AtomText: Ben's *11pm* is emphasis, never a literal asterisk.
    expect(within(midnight).getByText('11pm').tagName).toBe('EM');
    const closed = state.proposals.find((p) => p.id === ids.midnight);
    if (closed === undefined) throw new Error();
    expect(midnight).toHaveTextContent(
      `${messages.history.proposedBy} Ben${messages.history.decided} ${formatDay(closeTime(closed))}`,
    );
    expect(within(midnight).getByText('Ben').tagName).toBe('BDI');
    expect(within(midnight).getByText('Summer nights.')).toBeVisible();
    expect(within(midnight).getByText(messages.result.totalsLine(4, '4.0', 0))).toBeVisible();
    expect(
      within(midnight).getByRole('link', { name: messages.history.seeResult }),
    ).toHaveAttribute('href', `#/g/${state.group ?? ''}/p/${ids.midnight}`);
    expect(within(quiet).getByText('Quiet after 10pm.')).toBeVisible();
    expect(within(founding).getByText('Quiet hours start at ten.')).toBeVisible();
    expect(founding).toHaveTextContent(`${messages.history.writtenBy} Ana`);
    expect(within(founding).queryByRole('link')).toBeNull();
    expect(within(sheet).queryByText(messages.history.unchanged)).toBeNull();
  });

  it('keeps the Proposals that didn’t pass under a disclosure, each with its outcome and date', async () => {
    const user = userEvent.setup();
    const { state, ids } = story();
    documentView(state);
    const sheet = await openHistory(user, 1);
    const toggle = within(sheet).getByRole('button', { name: messages.history.notPassed(2) });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    const failed = within(sheet).getByRole('list', { name: messages.history.notPassed(2) });
    const rows = within(failed).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(`Quiet at nine${messages.decided.outcomes.lapse}`),
      expect.stringContaining(`No quiet hours${messages.decided.outcomes.fail}`),
    ]);
    expect(within(failed).getByRole('link', { name: 'No quiet hours' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/p/${ids.none}`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('never names a voter who didn’t write the text, nor any note: those stay in the result', async () => {
    const user = userEvent.setup();
    const { state } = story();
    documentView(state);
    const sheet = await openHistory(user, 1);
    await user.click(within(sheet).getByRole('button', { name: /didn’t pass/ }));
    expect(sheet.textContent).toContain('Ben');
    expect(document.body.textContent).not.toMatch(/canary/i);
  });

  it('says nothing has changed a section since it began, with no disclosure', async () => {
    const user = userEvent.setup();
    const { state } = story();
    documentView(state);
    const sheet = await openHistory(user, 2);
    expect(within(sheet).getByText(messages.history.unchanged)).toBeVisible();
    expect(entriesOf(sheet)).toHaveLength(1);
    expect(within(sheet).queryByRole('button', { name: /didn’t pass/ })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers History to someone who only reads, with no Propose', async () => {
    const user = userEvent.setup();
    const log = groupLog({ members: ['Ben'], levels: { Ben: FOLLOWING } });
    documentView(log.state(), authorOf('ben'));
    expect(screen.queryByRole('button', { name: /Propose/ })).toBeNull();
    const sheet = await openHistory(user, 2);
    expect(within(sheet).getByText('Bins go out on Tuesday.')).toBeVisible();
  });

  it('shows a removal as the pass that removed the section, with no text', async () => {
    const user = userEvent.setup();
    const log = groupLog({ members: VOTERS.slice(1) });
    const removal = log.propose('Ben', { atom: 1, title: 'No bins rule', why: '', text: '' });
    everyone(log, removal, { [removal]: 4 });
    const state = log.state(log.minute + 1);
    const source = groupHistory(state);
    render(
      <main>
        <HistorySheet source={source} atomId={`${log.group}.1`} section={null}>
          <Button>Open</Button>
        </HistorySheet>
      </main>,
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const sheet = screen.getByRole('dialog', { name: messages.history.removedTitle });
    const [removed] = entriesOf(sheet);
    if (removed === undefined) throw new Error();
    expect(removed).toHaveTextContent(messages.history.removed);
    expect(removed.querySelector('.atom-text')).toBeNull();
    // A Proposal with no why shows no empty line for it.
    expect(removed.querySelector('.history-why')).toBeNull();
  });

  it('shows a move as the pass that moved the section, over the text it still reads, naming no voter (#103)', async () => {
    const user = userEvent.setup();
    const log = groupLog({ members: VOTERS.slice(1) });
    const move = log.move('Ben', `${log.group}.1`, null, { title: 'Bins first', why: 'Tuesday.' });
    everyone(log, move, { [move]: 4 });
    const state = log.state(log.minute + 1);
    documentView(state);
    const sheet = await openHistory(user, 1);
    const [moved, founded] = entriesOf(sheet);
    if (moved === undefined || founded === undefined) throw new Error();
    expect(within(moved).getByRole('heading', { level: 3 })).toHaveTextContent('Bins first');
    expect(within(moved).getByText(messages.history.movedToTop)).toBeVisible();
    expect(within(moved).getByText('Bins go out on Tuesday.')).toBeVisible();
    expect(moved).toHaveTextContent('Proposed by Ben');
    expect(within(founded).getByText('Bins go out on Tuesday.')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/canary/i);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows a class change as the pass that protected the section, over its text, and opens on an eternal section (#116)', async () => {
    const user = userEvent.setup();
    const log = groupLog({ members: VOTERS.slice(1) });
    const entrench = log.protect('Ben', `${log.group}.0`, 'entrenched', { title: 'Protect it' });
    everyone(log, entrench, { [entrench]: 4 });
    log.minute += 5;
    const eternal = log.protect('Ben', `${log.group}.0`, 'eternal', { title: 'Keep it' });
    everyone(log, eternal, { [eternal]: 4 });
    documentView(log.state(log.minute + 1));
    const sheet = await openHistory(user, 1);
    const [made, protectedIt, founded] = entriesOf(sheet);
    if (made === undefined || protectedIt === undefined || founded === undefined) {
      throw new Error('Expected three entries.');
    }
    expect(within(made).getByRole('heading', { level: 3 })).toHaveTextContent('Keep it');
    expect(within(made).getByText(messages.history.classChanged.eternal)).toBeVisible();
    expect(within(made).getByText('Quiet hours start at ten.')).toBeVisible();
    expect(made).toHaveTextContent('Proposed by Ben');
    expect(within(protectedIt).getByText(messages.history.classChanged.entrenched)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/canary/i);
    expect(await axeViolations()).toEqual([]);
  });

  it('reads a cleared Proposal’s totals from its result, and still names its author, not its voters (#111)', async () => {
    const user = userEvent.setup();
    const log = groupLog({ members: VOTERS.slice(1) });
    const bins = log.propose('Ben', { atom: 1, title: 'Bins', text: 'Bins go out on Monday.\n' });
    everyone(log, bins, { [bins]: 3 });
    log.minute += 5;
    const decided = log.state().proposals.find((p) => p.id === bins);
    if (decided === undefined) throw new Error();
    log.result('Ana', resultFor(decided));
    const kept = log.records.filter((record) => {
      const event = parseRecord(record.bytes)?.event;
      return event === undefined || event.type !== 'vote' || expiringProposal(event) !== bins;
    });
    const state = fold(kept, log.minute + 1, [], [bins]);
    expect(state.proposals.find((p) => p.id === bins)?.cleared).toBe(true);
    documentView(state);
    const sheet = await openHistory(user, 2);
    const [entry] = entriesOf(sheet);
    if (entry === undefined) throw new Error();
    expect(within(entry).getByText(messages.result.totalsLine(4, '3.0', 0))).toBeVisible();
    expect(entry).toHaveTextContent(`${messages.history.proposedBy} Ben`);
    expect(document.body.textContent).not.toMatch(/canary/i);
  });
});

describe('a coalition’s section history (#120; ADR-0036)', () => {
  const R = 29_375_000;
  const WEEK = 10_080;
  const GRACE = 10_080;

  /** A coalition of A, whose voters carry canary names, and B; Zed's motion passes in both. */
  function coalition() {
    const logs = new Logs();
    logs.group('A', R, ['canaryana', 'canaryben']);
    const reconcile = logs.reconcile('A', R + 3, 'canaryana', 'A');
    logs.vote('A', R + 4, 'canaryana', reconcile, 4);
    logs.vote('A', R + 5, 'canaryben', reconcile, 4);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'zed', 'We keep the river and its banks clean.');
    logs.vote('A', at + 1, 'canaryana', motion, 4, 'canary note');
    logs.vote('A', at + 2, 'canaryben', motion, 3);
    logs.result(at + 3, 'kim', motion, 'A', 'pass');
    logs.result(at + 4, 'zed', motion, 'B', 'pass');
    const state = folded(foldLogs(logs.logs, at + WEEK + GRACE + 1), 'coalition').state;
    return { state, motion, atom: `${logs.ids.coalition ?? ''}.0` };
  }

  /** Renders the coalition section's sheet, opened, with `href` as each motion's result. */
  async function sheetFor(state: GroupState, atom: string, href: string | null) {
    const user = userEvent.setup();
    const source: HistorySource = {
      historyOf: (id) => sectionHistory(state, id),
      names: state,
      resultHref: () => href,
    };
    render(
      <main>
        <HistorySheet source={source} atomId={atom} section={1}>
          <Button>Open</Button>
        </HistorySheet>
      </main>,
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    return screen.getByRole('dialog', { name: messages.history.title(1) });
  }

  it('shows each group’s pass, no totals, and the founding text with no one named', async () => {
    const { state, motion, atom } = coalition();
    const sheet = await sheetFor(state, atom, `#/g/A/p/${motion}`);
    const [passed, founding] = entriesOf(sheet);
    if (passed === undefined || founding === undefined) throw new Error();
    expect(passed).toHaveTextContent('We keep the river and its banks clean.');
    expect(passed).toHaveTextContent(`${messages.history.proposedBy} zed`);
    const groups = within(passed).getByRole('list', { name: messages.coalitions.eachGroup });
    expect(
      within(groups)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([`A${messages.coalitions.standing.pass}`, `B${messages.coalitions.standing.pass}`]);
    expect(passed).not.toHaveTextContent(/Scored by/);
    expect(within(passed).getByRole('link', { name: messages.history.seeResult })).toHaveAttribute(
      'href',
      `#/g/A/p/${motion}`,
    );
    expect(founding).not.toHaveTextContent(messages.history.writtenBy);
    expect(document.body.textContent).not.toMatch(/canary/i);
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no full result where no group on this device decided the motion', async () => {
    const { state, atom } = coalition();
    const sheet = await sheetFor(state, atom, null);
    expect(within(sheet).queryByRole('link', { name: messages.history.seeResult })).toBeNull();
  });
});
