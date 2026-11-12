/**
 * The first-run guide (#91): up to three cards, each shown only when `can()`
 * allows its action, after the first Create group or Join on a device, and
 * never again once skipped or done. A dissolved group's copy shows none (#108).
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Level, LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { DEFAULT_RULES } from '../engine/rules';
import { GUIDE_KEY, guideRecord } from '../platform/guide';
import { type TestDevice, testDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { createGroup, makeInvite } from './actions';
import { App } from './App';
import { FirstRunGuide } from './FirstRunGuide';

freshIndexedDBPerTest();

const devices: TestDevice[] = [];

afterEach(() => {
  for (const device of devices.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
  window.localStorage.clear();
});

/** The levels, from following to creating; code never spells their names (ADR-0021). */
const [FOLLOWING, VOTING, CREATING] = LEVELS;

const PROPOSE =
  'Suggest new wording for any section, with a short reason. Nothing changes until the group agrees.';
const VOTE =
  'Score each version from 0 (strongly opposed) to 4 (strongly supportive). Most changes pass when the average is at least 2.0 and fewer than 10% of scores are 0. A 0 needs a reason.';
const DISCUSS = 'Talk it through in your group’s own chat. Every Proposal links to it.';

/** Ana's group, with Ben at `level`: the state Ben's device folds once his join is back. */
function bensGroup(level: Level): GroupState {
  return groupLog({ members: ['Ben'], levels: { Ben: level } }).state();
}

function showGuide(state: GroupState, me: string) {
  const onClose = vi.fn();
  // Group home names the tab, under the guide.
  document.title = 'Your group · Reconcile';
  render(
    <main>
      <FirstRunGuide state={state} me={me} onClose={onClose} />
    </main>,
  );
  return { user: userEvent.setup(), onClose };
}

/** The card's heading, eyebrow, words and buttons, as the dialog shows them now. */
function card() {
  const dialog = screen.getByRole('dialog');
  return {
    dialog,
    title: within(dialog).getByRole('heading').textContent,
    step: dialog.querySelector('.eyebrow')?.textContent,
    body: dialog.querySelector('.lede')?.textContent,
    buttons: within(dialog)
      .getAllByRole('button')
      .map((button) => [button.textContent, button.hasAttribute('disabled')]),
  };
}

describe('FirstRunGuide', () => {
  it('walks a Co-Creator through Propose, Vote and Discuss, with Back, Next and Skip on each', async () => {
    const { user, onClose } = showGuide(bensGroup(CREATING), authorOf('ben'));

    expect(card()).toMatchObject({
      title: 'Propose',
      step: '1 of 3',
      body: PROPOSE,
      buttons: [
        ['Back', true],
        ['Next', false],
        ['Skip', false],
      ],
    });
    expect(card().dialog).toHaveAccessibleName('Propose');
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(card()).toMatchObject({ title: 'Vote 0–4', step: '2 of 3', body: VOTE });
    expect(screen.getByRole('heading', { name: 'Vote 0–4' })).toHaveFocus();
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(card()).toMatchObject({
      title: 'Discuss in your chat',
      step: '3 of 3',
      body: DISCUSS,
      buttons: [
        ['Back', false],
        ['Done', false],
        ['Skip', false],
      ],
    });
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Vote 0–4' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Skip from the first card, and on Escape', async () => {
    const skipped = showGuide(bensGroup(CREATING), authorOf('ben'));
    await skipped.user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(skipped.onClose).toHaveBeenCalledTimes(1);

    cleanup();
    const escaped = showGuide(bensGroup(CREATING), authorOf('ben'));
    await escaped.user.keyboard('{Escape}');
    expect(escaped.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows no Propose card to someone who may not propose', () => {
    showGuide(bensGroup(VOTING), authorOf('ben'));
    expect(card()).toMatchObject({ title: 'Vote 0–4', step: '1 of 2', body: VOTE });
    expect(screen.queryByText(PROPOSE)).not.toBeInTheDocument();
  });

  it('shows a Member, who follows along, only the Discuss card', () => {
    showGuide(bensGroup(FOLLOWING), authorOf('ben'));
    expect(card()).toMatchObject({
      title: 'Discuss in your chat',
      step: '1 of 1',
      buttons: [
        ['Back', true],
        ['Done', false],
        ['Skip', false],
      ],
    });
  });

  it('shows a Co-Creator still earning a vote (#101) only the Discuss card', () => {
    const state = groupLog({ members: ['Ben', 'Cal'], newcomers: ['Kim'] }).state();
    showGuide(state, authorOf('kim'));
    expect(card()).toMatchObject({ title: 'Discuss in your chat', step: '1 of 1', body: DISCUSS });
    expect(screen.queryByText(PROPOSE)).not.toBeInTheDocument();
    expect(screen.queryByText(VOTE)).not.toBeInTheDocument();
  });

  it('waits until the relay has returned the person’s join', () => {
    showGuide(bensGroup(CREATING), authorOf('cal'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers nothing on a dissolved group’s read-only copy (#108)', () => {
    const log = groupLog({ members: ['Ben'], levels: { Ben: CREATING } });
    const motion = log.proposeDissolve('ana', false);
    for (const name of ['ana', 'ben']) log.vote(name, motion, 4);
    log.dissolve('ben', motion);
    const state = log.state();
    expect(state.dissolved).not.toBeNull();

    showGuide(state, authorOf('ben'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reads its numbers from the group’s ordinary bar and the score scale, never the copy', () => {
    expect(DEFAULT_RULES.bars.ordinary).toEqual({ avgAtLeast: 2, zerosUnderPercent: 10 });
    const state = bensGroup(VOTING);
    const ordinary = { avgAtLeast: 3, zerosUnderPercent: 5 };
    const rules = { ...state.rules, bars: { ...state.rules.bars, ordinary } };
    showGuide({ ...state, rules }, authorOf('ben'));
    expect(card().body).toBe(
      'Score each version from 0 (strongly opposed) to 4 (strongly supportive). Most changes pass when the average is at least 3.0 and fewer than 5% of scores are 0. A 0 needs a reason.',
    );
  });
});

async function device(fake: FakeRelay, name: string): Promise<TestDevice> {
  const opened = await testDevice(fake, name);
  devices.push(opened);
  return opened;
}

/** Creates "Riverside Tenants" through Create group. */
async function createRiverside(user: UserEvent): Promise<void> {
  await user.click(await screen.findByRole('link', { name: 'Create group' }));
  const entries: [string, string][] = [
    ['Group name', 'Riverside Tenants'],
    ['Your name', 'Ana'],
    ['Document title', 'House rules'],
    ['Document text', 'Quiet hours start at ten.'],
  ];
  for (const [label, value] of entries) {
    // Create group's first Document starts titled Mission statement (#92), so each field is cleared.
    await user.clear(await screen.findByRole('textbox', { name: label }));
    await user.click(screen.getByRole('textbox', { name: label }));
    await user.paste(value);
  }
  await user.click(screen.getByRole('button', { name: 'Create group' }));
}

/** An invite link to a group Cal founded on another device. */
async function calsInvite(fake: FakeRelay): Promise<string> {
  const cal = await device(fake, 'cal');
  const values = {
    groupName: 'Allotment',
    yourName: 'Cal',
    chat: null,
    documents: [{ title: 'Plot rules', text: 'Water before nine.' }],
  };
  const created = await createGroup(cal.services, values);
  if (created.outcome !== 'created') throw new Error('Expected a group.');
  await cal.services.sync.syncOnce();
  return makeInvite(cal.services, created.groupId, cal.services.origin);
}

describe('the first-run guide in the app', () => {
  it('appears after the first create, and not after a second join', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const link = await calsInvite(fake);
    const ana = await device(fake, 'ana');
    render(<App services={{ ...ana.services, guide: guideRecord() }} />);

    await createRiverside(user);
    const dialog = await screen.findByRole('dialog', { name: 'Propose' });
    expect(within(dialog).getByText('1 of 3')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(GUIDE_KEY)).toBe('1');
    expect(screen.getByRole('heading', { level: 1, name: 'Riverside Tenants' })).toBeVisible();

    // Ana joins a second group: Group home opens with no guide.
    window.history.replaceState(null, '', new URL(link).hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ana');
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    const people = await screen.findByRole('region', { name: 'People' });
    await waitFor(() => {
      expect(within(people).getAllByRole('listitem')).toHaveLength(2);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('appears after a first join with the cards the joiner’s level allows', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const link = await calsInvite(fake);
    const ben = await device(fake, 'ben');
    window.history.replaceState(null, '', new URL(link).hash);
    render(<App services={{ ...ben.services, guide: guideRecord() }} />);

    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ben');
    await user.click(screen.getByRole('button', { name: 'Join group' }));

    // Collaborator, the level Join preselects, votes but doesn't propose.
    const dialog = await screen.findByRole('dialog', { name: 'Vote 0–4' });
    expect(within(dialog).getByText('1 of 2')).toBeVisible();
    expect(within(dialog).getByText(VOTE)).toBeVisible();
  });

  it('closes on Skip from card 1 and doesn’t return after a reload', async () => {
    const user = userEvent.setup();
    const ana = await device(createFakeRelay(), 'ana');
    const services = { ...ana.services, guide: guideRecord() };
    const first = render(<App services={services} />);
    await createRiverside(user);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Skip' }),
    );
    first.unmount();

    // The reload: the same device and route, a fresh app.
    render(<App services={services} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    await ana.services.sync.syncOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never shows where the app has no guide record, as in other screens’ tests', async () => {
    const user = userEvent.setup();
    const ana = await device(createFakeRelay(), 'ana');
    render(<App services={ana.services} />);
    await createRiverside(user);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
