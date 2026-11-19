/**
 * Group rules (#117): each opt-in with where it stands, its warning, and a
 * link to propose a change, never a toggle; Turn off now for a steward only.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { base64url } from '../crypto/base64url';
import { addressOf } from '../door/page';
import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { DOOR, doorOf, lapsedNarrowing, LISTED, RELISTED } from '../test/door';
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
    expect(warnings.chatBot).toMatch(
      / Discord also sees the internet address of the member’s phone that posts each notice\.$/,
    );
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
    const open = log.rules('Ana', 'frontDoor', DOOR);
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
    const open = log.rules('Ben', 'frontDoor', DOOR);
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

describe('GroupRules: an open front door (#121)', () => {
  const ORIGIN = 'https://reconcile.test';

  /** Ana, Ben and Cal's group with its front door open as `value`. */
  function doorOpen(value: unknown = DOOR) {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.rules('Ana', 'frontDoor', value);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
    return log;
  }

  it('gives its link to copy and post anywhere, and says the count stays hidden', async () => {
    const user = userEvent.setup();
    const copyText = vi.fn(() => Promise.resolve());
    render(
      <GroupRules
        state={doorOpen().state()}
        me={authorOf('ben')}
        origin={ORIGIN}
        copyText={copyText}
      />,
    );
    const link = `${ORIGIN}/#door/${base64url(addressOf(DOOR))}`;
    expect(within(door()).getByText('Open')).toBeVisible();
    expect(within(door()).getByRole('textbox', { name: 'Front door link' })).toHaveValue(link);
    expect(within(door()).getByText(messages.door.uncounted)).toBeVisible();
    await user.click(within(door()).getByRole('button', { name: 'Copy link' }));
    expect(copyText).toHaveBeenCalledWith(link);
    expect(document.body.innerHTML).not.toContain(DOOR.sign);
    expect(document.body.innerHTML).not.toContain(DOOR.box);
    expect(await axeViolations()).toEqual([]);
  });

  it('says when the page shows the count', () => {
    render(
      <GroupRules
        state={doorOpen({ ...DOOR, showCount: true }).state()}
        me={authorOf('ben')}
        origin={ORIGIN}
        copyText={() => Promise.resolve()}
      />,
    );
    expect(within(door()).getByText(messages.door.counted)).toBeVisible();
  });

  it('gives no link once a steward has narrowed it', () => {
    const log = doorOpen();
    const off = log.rules('Ana', 'frontDoor', false);
    log.narrow('Ana', 'frontDoor', off);
    render(
      <GroupRules
        state={log.state()}
        me={authorOf('ben')}
        origin={ORIGIN}
        copyText={() => Promise.resolve()}
      />,
    );
    expect(within(door()).queryByRole('textbox', { name: 'Front door link' })).toBeNull();
  });
});

describe('GroupRules: a door closed because a member left (#288)', () => {
  /** Ana, Ben and Cal's group with its front door open, then Cal's leave. */
  function closedByLeave() {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.rules('Ana', 'frontDoor', DOOR);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
    log.leave('Cal');
    return log;
  }

  it('says why it closed and how to reopen it, with no link, and a Proposal to open it', async () => {
    const log = closedByLeave();
    render(
      <GroupRules
        state={log.state()}
        me={authorOf('ben')}
        origin="https://reconcile.test"
        copyText={() => Promise.resolve()}
      />,
    );
    expect(within(door()).getByText('Closed')).toBeVisible();
    expect(within(door()).getByText(messages.optIns.doorClosedByLeave)).toBeVisible();
    expect(messages.optIns.doorClosedByLeave).toBe(
      'The front door closed because a member left, and they still have its keys. A new Proposal to open it reopens it, with new keys and a new link.',
    );
    expect(within(door()).queryByRole('textbox', { name: 'Front door link' })).toBeNull();
    expect(
      within(door()).getByRole('link', { name: 'Propose turning this on for the front door' }),
    ).toHaveAttribute('href', `#/g/${log.group}/rules/frontDoor`);
    expect(await axeViolations()).toEqual([]);
  });

  it('says nothing of a leave when the door was closed already, or once it opens again', () => {
    const quiet = groupLog({ members: ['Ben', 'Cal'] });
    quiet.leave('Cal');
    const { unmount } = renderRules(quiet.state(), 'ben');
    expect(within(door()).queryByText(messages.optIns.doorClosedByLeave)).toBeNull();
    unmount();

    const log = closedByLeave();
    log.rotate('Ana');
    const reopen = log.rules('Ana', 'frontDoor', doorOf(0x77, 0x78));
    for (const name of ['Ana', 'Ben']) log.vote(name, reopen, 4);
    renderRules(log.state(), 'ben');
    expect(within(door()).getByText('Open')).toBeVisible();
    expect(within(door()).queryByText(messages.optIns.doorClosedByLeave)).toBeNull();
  });
});

describe('GroupRules: listing the front door (#485; ADR-0081)', () => {
  const { listing } = messages.optIns;

  /** Ana, Ben and Cal's group with its front door open as `value`. */
  function doorOpen(value: unknown) {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.rules('Ana', 'frontDoor', value);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
    return log;
  }

  it('offers listing an open door by a Proposal, under the front door, and says nothing of a listing', async () => {
    const log = doorOpen(DOOR);
    renderRules(log.state(), 'ben');
    expect(within(door()).getByRole('link', { name: listing.proposeList })).toHaveAttribute(
      'href',
      `#/g/${log.group}/list/frontDoor`,
    );
    expect(within(door()).queryByText(listing.listed)).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('says a listed door is listed, and offers taking it off the shelf', async () => {
    const log = doorOpen(LISTED);
    renderRules(log.state(), 'ben');
    expect(within(door()).getByText(listing.listed)).toBeVisible();
    expect(within(door()).getByRole('link', { name: listing.proposeUnlist })).toHaveAttribute(
      'href',
      `#/g/${log.group}/list/frontDoor`,
    );
    expect(within(door()).queryByRole('link', { name: listing.proposeList })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no listing while the door is closed, nor to someone who doesn’t propose', () => {
    renderRules(groupLog({ members: ['Ben', 'Cal'] }).state(), 'ben');
    expect(within(door()).queryByRole('link', { name: listing.proposeList })).toBeNull();
    const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING } });
    const open = log.rules('Ana', 'frontDoor', LISTED);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
    cleanup();
    renderRules(log.state(), 'cal');
    expect(within(door()).getByText(listing.listed)).toBeVisible();
    expect(within(door()).queryByRole('link', { name: listing.proposeUnlist })).toBeNull();
  });

  it('says a door whose listing a lapsed narrowing ended is off the shelf, and offers listing it again (#501)', async () => {
    const log = lapsedNarrowing(doorOpen(LISTED));
    renderRules(log.state(), 'ben');
    expect(within(door()).getByText('Open')).toBeVisible();
    expect(within(door()).getByText(listing.ended)).toBeVisible();
    expect(within(door()).queryByText(listing.listed)).toBeNull();
    expect(within(door()).getByRole('link', { name: listing.proposeList })).toHaveAttribute(
      'href',
      `#/g/${log.group}/list/frontDoor`,
    );
    expect(within(door()).queryByRole('link', { name: listing.proposeUnlist })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('says the door is listed again once one vote lists it at new keys (#501)', async () => {
    const log = lapsedNarrowing(doorOpen(LISTED));
    const relist = log.rules('Ben', 'frontDoor', RELISTED);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, relist, 4);
    log.minute += 1;
    renderRules(log.state(), 'ben');
    expect(within(door()).queryByText(listing.ended)).toBeNull();
    expect(within(door()).getByText(listing.listed)).toBeVisible();
    expect(within(door()).getByRole('link', { name: listing.proposeUnlist })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says the listing ended for good the moment a steward’s narrowing holds the door shut (#501)', () => {
    const log = doorOpen(LISTED);
    const off = log.rules('Ana', 'frontDoor', false);
    log.narrow('Ana', 'frontDoor', off);
    renderRules(log.state(), 'ben');
    expect(within(door()).getByText(listing.ended)).toBeVisible();
    expect(within(door()).queryByRole('link', { name: listing.proposeList })).toBeNull();
  });

  it('says nothing of a listing once a steward’s narrowing holds the door shut', () => {
    const log = doorOpen(LISTED);
    const off = log.rules('Ana', 'frontDoor', false);
    log.narrow('Ana', 'frontDoor', off);
    renderRules(log.state(), 'ben');
    expect(within(door()).queryByText(listing.listed)).toBeNull();
  });
});
