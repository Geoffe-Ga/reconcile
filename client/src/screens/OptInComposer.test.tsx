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
import { base64url } from '../crypto/base64url';
import { addressOf } from '../door/page';
import { COVENANT, COVENANT_HASH } from '../shelf/covenant';
import type { ShelfState } from '../shelf/fold';
import { DOOR, lapsedNarrowing, LISTED, secretOf } from '../test/door';
import { authorOf } from '../test/keys';
import { held, pastPressFallback } from '../test/press';
import { groupLog } from '../test/votes';
import { OptInComposer, type OptInOutcome } from './OptInComposer';

const [, VOTING] = LEVELS;
const WEBHOOK = 'https://discord.com/api/webhooks/1199000000000000001/sEcReT-tokenWXYZ';
const { optIns, door, covenant } = messages;

interface Options {
  readonly me?: string;
  readonly optIn?: OptIn;
  readonly narrow?: boolean;
  readonly listing?: boolean;
  readonly outcome?: OptInOutcome | Promise<OptInOutcome>;
  /** The public shelf the device holds (#487). */
  readonly shelf?: ShelfState | null;
}

/** The device clock in tests, in ms. */
const NOW_MS = 1_762_650_000_000;

function renderComposer(state: GroupState, options: Options = {}) {
  const { me = 'ana', optIn = 'chatBot', narrow = false, outcome = 'proposed' } = options;
  const { listing = false, shelf } = options;
  const onPropose = vi.fn<(values: RulesValues) => Promise<OptInOutcome>>(() =>
    Promise.resolve(outcome),
  );
  render(
    <OptInComposer
      state={state}
      me={authorOf(me)}
      optIn={optIn}
      narrow={narrow}
      listing={listing}
      now={NOW_MS}
      onPropose={onPropose}
      shelf={shelf}
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

  it('proposes once when it is tapped again while it proposes and the save fails (#193)', async () => {
    const proposing = held<OptInOutcome>();
    const { user, onPropose } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state(), {
      outcome: proposing.promise,
    });
    await type(user, 'Discord webhook URL', WEBHOOK);
    await type(user, 'Why', 'Nudges help.');
    const send = screen.getByRole('button', { name: 'Propose this change' });
    await user.click(send);
    expect(send).toBeDisabled();
    await user.click(send);
    proposing.resolve('failed');
    expect(await screen.findByRole('alert')).toBeVisible();
    await pastPressFallback();
    expect(send).toBeEnabled();
    expect(onPropose).toHaveBeenCalledTimes(1);
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

/** Ana, Ben and Cal's group, with the front door at `value` by an entrenched pass. */
function doorAt(value: unknown) {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const open = log.rules('Ana', 'frontDoor', value);
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
  return log;
}

/** The covenant's section on screen. */
const covenantRegion = () => screen.queryByRole('region', { name: /The covenant/ });

/** Checks the covenant shows whole, marked a draft, with the line on what listing exposes. */
function expectCovenant() {
  const region = covenantRegion();
  expect(region).not.toBeNull();
  expect(region).toHaveTextContent(covenant.draft);
  expect(region).toHaveTextContent(covenant.draftLine);
  for (const clause of COVENANT.clauses) expect(region).toHaveTextContent(clause);
  expect(region).toHaveTextContent(covenant.exposure);
}

describe('OptInComposer: listing the front door (#485; ADR-0081)', () => {
  it('offers opening a door listed, unticked, and shows the covenant only once it is ticked', async () => {
    const { user, onPropose } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state(), {
      optIn: 'frontDoor',
    });
    const list = screen.getByRole('checkbox', { name: optIns.listing.choiceLabel });
    expect(list).not.toBeChecked();
    expect(covenantRegion()).toBeNull();
    await user.click(list);
    expectCovenant();
    await type(user, 'Why', 'We want to be found.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    const [[values]] = onPropose.mock.calls as [[RulesValues]];
    expect(values).toMatchObject({ optIn: 'frontDoor', window: 14 });
    expect(values.value).toMatchObject({ showCount: false, listed: true, covenant: COVENANT_HASH });
    expect(isOptInValue('frontDoor', values.value)).toBe(true);
    expect(await axeViolations()).toEqual([]);
  });

  it('lists an open door by its own Proposal, at the higher bar, under the covenant', async () => {
    const { user, onPropose } = renderComposer(doorAt(DOOR).state(), {
      optIn: 'frontDoor',
      listing: true,
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'List the front door on the public shelf',
    );
    expect(screen.getByText(/higher bar: an average of 3\.0 or more/)).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expectCovenant();
    await type(user, 'Why', 'We want to be found.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).toHaveBeenCalledWith({
      optIn: 'frontDoor',
      value: { ...DOOR, listed: true, covenant: COVENANT_HASH },
      title: 'List the front door on the public shelf',
      why: 'We want to be found.',
      narrow: false,
      window: 14,
    });
    expect(await axeViolations()).toEqual([]);
  });

  it('unlists a listed door at the ordinary bar, written as the door before #485', async () => {
    const { user, onPropose } = renderComposer(doorAt(LISTED).state(), {
      optIn: 'frontDoor',
      listing: true,
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Take the front door off the public shelf',
    );
    expect(screen.queryByText(/higher bar/)).toBeNull();
    expect(covenantRegion()).toBeNull();
    await type(user, 'Why', 'We have enough people now.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    const [[values]] = onPropose.mock.calls as [[RulesValues]];
    expect(values).toMatchObject({ window: 7, title: 'Take the front door off the public shelf' });
    expect(values.value).toStrictEqual(DOOR);
  });

  it('lists a door again in one vote at new keys and the higher bar, once a lapsed narrowing ended its listing (#501)', async () => {
    const { user, onPropose } = renderComposer(lapsedNarrowing(doorAt(LISTED)).state(), {
      optIn: 'frontDoor',
      listing: true,
      me: 'ben',
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      optIns.listing.motions.list,
    );
    expect(screen.getByText(optIns.listing.newLink)).toBeVisible();
    expect(screen.getByText(/higher bar: an average of 3\.0 or more/)).toBeVisible();
    expectCovenant();
    await type(user, 'Why', 'We want to be found again.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    const [[values]] = onPropose.mock.calls as [[RulesValues]];
    expect(values).toMatchObject({
      optIn: 'frontDoor',
      window: 14,
      title: optIns.listing.motions.list,
    });
    if (!isFrontDoor(values.value)) throw new Error('expected a front door');
    expect(values.value).toMatchObject({ showCount: false, listed: true, covenant: COVENANT_HASH });
    // The shelf holds the old address's listing final, so the door moves.
    expect(values.value.sign).not.toBe(DOOR.sign);
    expect(values.value.box).not.toBe(DOOR.box);
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps an open door’s keys when no listing has used its address', async () => {
    const { user, onPropose } = renderComposer(doorAt(DOOR).state(), {
      optIn: 'frontDoor',
      listing: true,
    });
    expect(screen.queryByText(optIns.listing.newLink)).toBeNull();
    await type(user, 'Why', 'We want to be found.');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    const [[values]] = onPropose.mock.calls as [[RulesValues]];
    expect(values.value).toMatchObject({ sign: DOOR.sign, box: DOOR.box });
  });

  it('offers no listing while the door is closed', () => {
    renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state(), {
      optIn: 'frontDoor',
      listing: true,
    });
    expect(screen.getByText(optIns.listing.unavailable)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

/** A shelf holding one listing, `name`, at `address`. */
function shelfWith(name: string, address = secretOf(0x66)): ShelfState {
  const listing = { address, name, covenant: COVENANT_HASH, seq: 3, received: 100 };
  return {
    listings: [listing],
    entries: [],
    withdrawn: [],
    tombstones: [],
    holds: [],
    paused: false,
  };
}

/** The line warning that another listed group already holds a name like this one. */
const lookAlike = () => screen.queryByText(optIns.listing.lookAlike);

describe('OptInComposer: a name like a listed group’s (#487; ADR-0081)', () => {
  it('warns before listing under a name a listed group already holds', async () => {
    renderComposer(doorAt(DOOR).state(), {
      optIn: 'frontDoor',
      listing: true,
      shelf: shelfWith('RIVERSIDE TENANTS'),
    });
    expect(optIns.listing.lookAlike).toBe(
      'A listed group already uses a name like this. Yours won’t be shown while theirs is.',
    );
    expect(lookAlike()).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('warns once opening a door is ticked to list it too', async () => {
    const { user } = renderComposer(groupLog({ members: ['Ben', 'Cal'] }).state(), {
      optIn: 'frontDoor',
      // A Cyrillic і, spaced and with a full stop.
      shelf: shelfWith('Rіverside  Tenants.'),
    });
    expect(lookAlike()).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: optIns.listing.choiceLabel }));
    expect(lookAlike()).toBeVisible();
  });

  it('says nothing for a name no listing holds, or with no shelf read', () => {
    renderComposer(doorAt(DOOR).state(), {
      optIn: 'frontDoor',
      listing: true,
      shelf: shelfWith('Riverside Neighbors'),
    });
    expect(lookAlike()).toBeNull();
    cleanup();
    renderComposer(doorAt(DOOR).state(), { optIn: 'frontDoor', listing: true, shelf: null });
    expect(lookAlike()).toBeNull();
  });

  it('says nothing of the door’s own listing, or when unlisting', () => {
    const own = shelfWith('Riverside Tenants', base64url(addressOf(DOOR)));
    renderComposer(doorAt(DOOR).state(), { optIn: 'frontDoor', listing: true, shelf: own });
    expect(lookAlike()).toBeNull();
    cleanup();
    renderComposer(doorAt(LISTED).state(), {
      optIn: 'frontDoor',
      listing: true,
      shelf: shelfWith('Riverside Tenants'),
    });
    expect(lookAlike()).toBeNull();
  });
});
