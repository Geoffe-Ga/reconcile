/**
 * Group rules (#117): each opt-in with where it stands, its warning, and a
 * link to propose a change, never a toggle; Turn off now for a steward only.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { messages } from '../app/messages';
import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { GroupRules } from './GroupRules';

const [FOLLOWING, VOTING] = LEVELS;
const WEBHOOK = 'https://discord.com/api/webhooks/1199000000000000001/sEcReT-tokenWXYZ';
const { warnings } = messages.optIns;

function renderRules(state: GroupState, me: string) {
  return render(<GroupRules state={state} me={authorOf(me)} />);
}

const bot = () => screen.getByRole('region', { name: 'Discord chat bot' });
const door = () => screen.getByRole('region', { name: 'Front door' });

/** Ana, Ben and Cal's group, with the chat bot turned on by an entrenched pass. */
function botOn() {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const on = log.rules('Ana', 'chatBot', { webhook: WEBHOOK });
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, on, 4);
  return log;
}

describe('GroupRules', () => {
  it('shows both opt-ins off, each with its warning and a link to propose turning it on', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const groupId = log.group;
    renderRules(log.state(), 'ben');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(messages.optIns.title);
    expect(within(bot()).getByText(warnings.chatBot)).toBeVisible();
    expect(within(door()).getByText(warnings.frontDoor)).toBeVisible();
    expect(within(bot()).getByText('Off')).toBeVisible();
    expect(within(door()).getByText('Closed')).toBeVisible();
    expect(
      within(bot()).getByRole('link', { name: 'Propose turning this on for the Discord chat bot' }),
    ).toHaveAttribute('href', `#/g/${groupId}/rules/chatBot`);
    expect(
      within(door()).getByRole('link', { name: 'Propose turning this on for the front door' }),
    ).toHaveAttribute('href', `#/g/${groupId}/rules/frontDoor`);
    expect(screen.getByText(messages.optIns.founding)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('has no control that changes an opt-in: only links to a Proposal’s composer', () => {
    renderRules(botOn().state(), 'ana');
    expect(screen.queryAllByRole('button')).toEqual([]);
    for (const role of ['switch', 'checkbox', 'radio', 'textbox']) {
      expect(screen.queryAllByRole(role)).toEqual([]);
    }
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(/^#\/g\/[^/]+(\/(rules|narrow)\/\w+)?$/);
    }
  });

  it('shows the bot on by its webhook’s last 4 only, with a link to propose turning it off', () => {
    const log = botOn();
    const { container } = renderRules(log.state(), 'ben');
    expect(within(bot()).getByText('On')).toBeVisible();
    expect(within(bot()).getByText('WXYZ')).toBeVisible();
    expect(container.innerHTML).not.toContain('sEcReT');
    expect(
      within(bot()).getByRole('link', {
        name: 'Propose turning this off for the Discord chat bot',
      }),
    ).toHaveAttribute('href', `#/g/${log.group}/rules/chatBot`);
  });

  it('shows an open front door as Open, with no webhook, and a link to propose closing it', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.rules('Ana', 'frontDoor', true);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
    renderRules(log.state(), 'ben');
    expect(within(door()).getByText('Open')).toBeVisible();
    expect(within(door()).queryByText(/Webhook ending in/)).toBeNull();
    expect(
      within(door()).getByRole('link', { name: 'Propose turning this off for the front door' }),
    ).toHaveAttribute('href', `#/g/${log.group}/rules/frontDoor`);
  });

  it('offers Turn off now to the steward, and to nobody else', async () => {
    const log = botOn();
    renderRules(log.state(), 'ana');
    expect(
      within(bot()).getByRole('link', { name: 'Turn off now for the Discord chat bot' }),
    ).toHaveAttribute('href', `#/g/${log.group}/narrow/chatBot`);
    expect(within(door()).queryByRole('link', { name: /^Turn off now/ })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no Turn off now to a member who holds no seat', () => {
    renderRules(botOn().state(), 'ben');
    expect(screen.queryByRole('link', { name: /Turn off/ })).toBeNull();
    expect(screen.queryByText(messages.optIns.turnOffNow)).toBeNull();
  });

  it('says the group is voting while a rules Proposal is open, and links to its vote', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.rules('Ben', 'frontDoor', true);
    renderRules(log.state(), 'cal');
    expect(within(door()).getByText(messages.optIns.voting)).toBeVisible();
    expect(within(door()).getByRole('link', { name: 'See the vote' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/p/${open}`,
    );
    expect(within(door()).queryByRole('link', { name: /^Propose/ })).toBeNull();
    expect(within(bot()).getByRole('link', { name: /^Propose/ })).toBeVisible();
  });

  it('says a steward turned it off for now, by name, and links to the vote', () => {
    const log = botOn();
    const off = log.rules('Ana', 'chatBot', null);
    log.narrow('Ana', 'chatBot', off);
    renderRules(log.state(), 'ben');
    expect(within(bot()).getByText(/turned it off while your group votes/)).toHaveTextContent(
      'Off for now. Steward Ana turned it off while your group votes.',
    );
    expect(within(bot()).getByRole('link', { name: 'See the vote' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/p/${off}`,
    );
    expect(within(bot()).queryByText('WXYZ')).toBeNull();
  });

  it('tells someone who votes but doesn’t propose how to propose, and offers no link', () => {
    const log = groupLog({ members: ['Ben', 'Cal'], levels: { Ben: VOTING } });
    renderRules(log.state(), 'ben');
    expect(screen.queryByRole('link', { name: /^Propose/ })).toBeNull();
    expect(screen.getAllByText(messages.levels.notProposing)).toHaveLength(2);
  });

  it('shows a suspended member the suspended line in place of any link', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    log.suspend('Ana', 'Ben');
    renderRules(log.state(), 'ben');
    expect(screen.getByText(/^A steward suspended you until/)).toBeVisible();
    expect(screen.queryByRole('link', { name: /^Propose/ })).toBeNull();
    expect(screen.queryByText(messages.levels.following)).toBeNull();
  });

  it('tells a Member who follows how to take part', () => {
    const log = groupLog({ members: ['Ben', 'Kim'], levels: { Kim: FOLLOWING } });
    renderRules(log.state(), 'kim');
    expect(screen.getAllByText(messages.levels.following)).toHaveLength(2);
  });
});
