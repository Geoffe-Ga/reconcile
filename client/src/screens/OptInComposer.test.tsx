/**
 * The opt-in composer (#117): a rules Proposal turning an opt-in on or off,
 * with its warning; turning the bot on asks for a webhook the engine's own
 * validator accepts; Turn off now also narrows it, for a steward only.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { RulesValues } from '../app/proposals';
import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { isFrontDoor, isOptInValue, type OptIn } from '../engine/optIns';
import { axeViolations } from '../test/axe';
import { DOOR } from '../test/door';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { OptInComposer, type OptInOutcome } from './OptInComposer';

const [, VOTING] = LEVELS;
const WEBHOOK = 'https://discord.com/api/webhooks/1199000000000000001/sEcReT-tokenWXYZ';
const { optIns, door } = messages;

interface Options {
  readonly me?: string;
  readonly optIn?: OptIn;
  readonly narrow?: boolean;
  readonly outcome?: OptInOutcome;
}

/** The device clock in tests, in ms. */
const NOW_MS = 1_762_650_000_000;

function renderComposer(state: GroupState, options: Options = {}) {
  const { me = 'ana', optIn = 'chatBot', narrow = false, outcome = 'proposed' } = options;
  const onPropose = vi.fn<(values: RulesValues) => Promise<OptInOutcome>>(() =>
    Promise.resolve(outcome),
  );
  render(
    <OptInComposer
      state={state}
      me={authorOf(me)}
      optIn={optIn}
      narrow={narrow}
      now={NOW_MS}
      onPropose={onPropose}
    />,
  );
  return { user: userEvent.setup(), onPropose };
}

/** Ana, Ben and Cal's group, with the chat bot on by an entrenched pass. */
function botOn() {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const on = log.rules('Ana', 'chatBot', { webhook: WEBHOOK });
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, on, 4);
  return log;
}

async function type(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
  await user.click(screen.getByRole('textbox', { name: label }));
  await user.paste(text);
}

describe('OptInComposer: turning the chat bot on', () => {
  it('heads the form with the motion, its warning and the higher bar, and asks for the webhook', async () => {
    renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Turn on the Discord chat bot',
    );
    expect(screen.getByText(optIns.warnings.chatBot)).toBeVisible();
    expect(
      screen.getByText(/higher bar: an average of 3\.0 or more, with zeros under 5%/),
    ).toBeVisible();
    const webhook = screen.getByRole('textbox', { name: 'Discord webhook URL' });
    expect(webhook).toBeVisible();
    expect(webhook).toHaveAccessibleDescription(
      'In Discord, open the channel’s settings › Integrations › Webhooks › Copy Webhook URL. Use a text channel, or a forum channel to give each Proposal its own thread. Only your group’s devices keep it, and the ballot shows only its last 4 characters.',
    );
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Turn on the Discord chat bot',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it.each([
    ['an http: link', 'http://discord.com/api/webhooks/1/abc'],
    ['another host', 'https://example.com/api/webhooks/1/abc'],
    ['a link with a query', `${WEBHOOK}?wait=true`],
  ])('refuses %s with the same validator as the fold, and sends nothing', async (_name, url) => {
    const { user, onPropose } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state());
    await type(user, 'Discord webhook URL', url);
    await type(user, 'Why', 'Nudges help.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(screen.getByText(optIns.webhookInvalid)).toBeVisible();
    expect(onPropose).not.toHaveBeenCalled();
  });

  it('asks for a webhook when none is pasted', async () => {
    const { user, onPropose } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state());
    await type(user, 'Why', 'Nudges help.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(screen.getByText(optIns.webhookMissing)).toBeVisible();
    expect(onPropose).not.toHaveBeenCalled();
  });

  it('proposes the trimmed webhook, the title and the why, without narrowing', async () => {
    const { user, onPropose } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state());
    await type(user, 'Discord webhook URL', `  ${WEBHOOK}\n`);
    await type(user, 'Why', '  Nudges help.  ');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).toHaveBeenCalledWith({
      optIn: 'chatBot',
      value: { webhook: WEBHOOK },
      title: 'Turn on the Discord chat bot',
      why: 'Nudges help.',
      narrow: false,
      window: 14,
    });
  });

  it('sends once however often the button is pressed, and stays off once proposed', async () => {
    const { user, onPropose } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state());
    await type(user, 'Discord webhook URL', WEBHOOK);
    await type(user, 'Why', 'Nudges help.');
    const send = screen.getByRole('button', { name: 'Propose this change' });
    await user.click(send);
    await user.click(send);
    expect(onPropose).toHaveBeenCalledTimes(1);
    expect(send).toBeDisabled();
  });

  it('says so when it couldn’t be saved, and keeps the form', async () => {
    const { user } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state(), {
      outcome: 'failed',
    });
    await type(user, 'Discord webhook URL', WEBHOOK);
    await type(user, 'Why', 'Nudges help.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(messages.stewards.failed);
    expect(screen.getByRole('button', { name: 'Propose this change' })).toBeEnabled();
  });

  it('ties a too-large Proposal’s message to the why', async () => {
    const { user } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state(), {
      outcome: 'too-large',
    });
    await type(user, 'Discord webhook URL', WEBHOOK);
    await type(user, 'Why', 'Nudges help.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(await screen.findByText(messages.composer.tooLarge)).toBeVisible();
  });
});

describe('OptInComposer: the voting time (#106)', () => {
  it('bounds turning the bot on to the entrenched 14 to 28 days, starting at 14', async () => {
    const { user, onPropose } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state());
    const days = screen.getByRole('textbox', { name: 'Voting time (days)' });
    expect(days).toHaveValue('14');
    expect(screen.getByText(/^Closes about /)).toBeVisible();
    await user.clear(days);
    await user.type(days, '13');
    await user.tab();
    await type(user, 'Discord webhook URL', WEBHOOK);
    await type(user, 'Why', 'Nudges help.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(screen.getByText('Choose from 14 to 28 days.')).toBeVisible();
    expect(onPropose).not.toHaveBeenCalled();
  });

  it('sends the days chosen within the bounds', async () => {
    const { user, onPropose } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state());
    const days = screen.getByRole('textbox', { name: 'Voting time (days)' });
    await user.clear(days);
    await user.type(days, '28');
    await user.tab();
    await type(user, 'Discord webhook URL', WEBHOOK);
    await type(user, 'Why', 'Nudges help.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).toHaveBeenCalledWith(expect.objectContaining({ window: 28 }));
  });

  it('bounds turning it off to the ordinary 3 to 14 days, starting at 7', () => {
    renderComposer(botOn().state(), { me: 'ben' });
    expect(screen.getByRole('textbox', { name: 'Voting time (days)' })).toHaveValue('7');
    expect(screen.queryByText(/higher bar/)).toBeNull();
  });
});

describe('OptInComposer: other changes', () => {
  it('opens a front door with no webhook field, and fresh door secrets made on this device (#121)', async () => {
    const { user, onPropose } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state(), {
      optIn: 'frontDoor',
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Open a front door');
    expect(screen.getByText(optIns.warnings.frontDoor)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Discord webhook URL' })).toBeNull();
    const count = screen.getByRole('checkbox', { name: door.countLabel });
    expect(count).not.toBeChecked();
    await type(user, 'Why', 'People keep asking how to join.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    const [[values]] = onPropose.mock.calls as [[RulesValues]];
    expect(values).toMatchObject({ optIn: 'frontDoor', narrow: false, window: 14 });
    expect(values.value).toEqual({
      sign: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      box: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      showCount: false,
    });
    expect(isOptInValue('frontDoor', values.value)).toBe(true);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the count only when the proposer ticks it, and each opening makes keys of its own', async () => {
    const state = groupLog({ members: ['Ben', 'Cal'] }).state();
    const first = renderComposer(state, { optIn: 'frontDoor' });
    await first.user.click(screen.getByRole('checkbox', { name: door.countLabel }));
    await type(first.user, 'Why', 'Show we are many.');
    await first.user.click(screen.getByRole('button', { name: 'Propose this change' }));
    cleanup();
    const second = renderComposer(state, { optIn: 'frontDoor' });
    await type(second.user, 'Why', 'People keep asking.');
    await second.user.click(screen.getByRole('button', { name: 'Propose this change' }));
    const [[counted]] = first.onPropose.mock.calls as [[RulesValues]];
    const [[hidden]] = second.onPropose.mock.calls as [[RulesValues]];
    expect(counted.value).toMatchObject({ showCount: true });
    expect(hidden.value).toMatchObject({ showCount: false });
    const keys = (value: unknown) => {
      if (!isFrontDoor(value)) throw new Error('Expected a front door.');
      return [value.sign, value.box];
    };
    expect(keys(counted.value)).not.toEqual(keys(hidden.value));
    expect(new Set([...keys(counted.value), ...keys(hidden.value)]).size).toBe(4);
  });

  it('closes an open front door with no count choice', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.rules('Ana', 'frontDoor', DOOR);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
    const { user, onPropose } = renderComposer(log.state(), { optIn: 'frontDoor' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Close the front door');
    expect(screen.queryByRole('checkbox')).toBeNull();
    await type(user, 'Why', 'Too much junk.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).toHaveBeenCalledWith(
      expect.objectContaining({ optIn: 'frontDoor', value: false, narrow: false }),
    );
  });

  it('turns the bot off at the ordinary bar, with no webhook field and no higher bar', async () => {
    const { user, onPropose } = renderComposer(botOn().state(), { me: 'ben' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Turn off the Discord chat bot',
    );
    expect(screen.queryByText(/higher bar/)).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Discord webhook URL' })).toBeNull();
    await type(user, 'Why', 'Too many pings.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).toHaveBeenCalledWith(
      expect.objectContaining({ optIn: 'chatBot', value: null, narrow: false }),
    );
  });
});

describe('OptInComposer: Turn off now', () => {
  it('lets the steward turn the bot off at once, with the line saying what happens', async () => {
    const { user, onPropose } = renderComposer(botOn().state(), { narrow: true });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Turn off the Discord chat bot now',
    );
    expect(screen.getByText(optIns.nowLine)).toBeVisible();
    await type(user, 'Why', 'Someone posted the webhook in public.');
    await user.click(screen.getByRole('button', { name: 'Turn off now' }));
    expect(onPropose).toHaveBeenCalledWith({
      optIn: 'chatBot',
      value: null,
      title: 'Turn off the Discord chat bot',
      why: 'Someone posted the webhook in public.',
      narrow: true,
      window: 7,
    });
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no form to a member who holds no seat', () => {
    renderComposer(botOn().state(), { me: 'ben', narrow: true });
    expect(screen.getByText(optIns.nowUnavailable)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers no form while the bot is already off', () => {
    renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state(), { narrow: true });
    expect(screen.getByText(optIns.nowUnavailable)).toBeVisible();
  });
});

describe('OptInComposer: where the fold would refuse it', () => {
  it('offers no form while a rules Proposal for the opt-in is open', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    log.rules('Ben', 'frontDoor', DOOR);
    renderComposer(log.state(), { optIn: 'frontDoor' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(optIns.unavailableTitle);
    expect(screen.getByText(optIns.unavailable)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a suspended member the suspended line, and no form', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    log.suspend('Ana', 'Ben');
    renderComposer(log.state(), { me: 'ben' });
    expect(screen.getByText(/^A steward suspended you until/)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('offers no form to someone who can’t propose', () => {
    const log = groupLog({ members: ['Ben', 'Cal'], levels: { Ben: VOTING } });
    renderComposer(log.state(), { me: 'ben' });
    expect(screen.getByText(messages.stewards.notAllowed)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
