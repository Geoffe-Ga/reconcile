import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { formatMinute } from '../app/time';
import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { DAY_MINUTES } from '../engine/rules';
import type { SeatNumber } from '../engine/stewards';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { held, pastPressFallback } from '../test/press';
import { groupLog, START_MINUTE } from '../test/votes';
import { StewardComposer, type StewardComposerProps, type StewardOutcome } from './StewardComposer';

const [FOLLOWING, VOTING] = LEVELS;

type OnPropose = StewardComposerProps['onPropose'];

interface Options {
  readonly me?: string;
  readonly seat?: SeatNumber;
  readonly recall?: boolean;
  readonly outcome?: StewardOutcome | Error | Promise<StewardOutcome>;
}

function renderComposer(state: GroupState, options: Options = {}) {
  const { me = 'ben', seat = 1, recall = false, outcome = 'proposed' } = options;
  const onPropose = vi.fn<OnPropose>(() =>
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
  );
  render(
    <StewardComposer
      state={state}
      me={authorOf(me)}
      seat={seat}
      recall={recall}
      onPropose={onPropose}
    />,
  );
  return { user: userEvent.setup(), onPropose };
}

/** Ana founds; Ben and Cal join as Co-Creators, Kim follows as a Member. */
function threeVoting() {
  return groupLog({ members: ['Ben', 'Cal', 'Kim'], levels: { Kim: FOLLOWING } });
}

/** Presses a React Aria radio: its native input is hidden under the label. */
async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('radio', { name }));
}

async function fillWhy(user: ReturnType<typeof userEvent.setup>, why: string) {
  await user.click(screen.getByRole('textbox', { name: 'Why' }));
  await user.paste(why);
}

describe('StewardComposer: Propose a steward', () => {
  it('lists who can stand for the seat, and nobody who follows or holds the other seat', async () => {
    renderComposer(threeVoting().state());
    expect(
      screen.getByRole('heading', { level: 1, name: 'Propose a steward for seat 1' }),
    ).toBeVisible();
    const nominees = screen.getByRole('radiogroup', { name: 'Who should hold this seat?' });
    expect(
      within(nominees)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('value')),
    ).toEqual(['ana', 'ben', 'cal'].map(authorOf));
    expect(within(nominees).queryByRole('radio', { name: 'Kim' })).toBeNull();
    expect(screen.getByText(/A steward can suspend someone at once, for 7 days/)).toBeVisible();
    expect(document.title).toBe('Propose a steward · Reconcile');
    expect(await axeViolations()).toEqual([]);
  });

  it('starts the title as the ballot line for the chosen nominee, and queues one steward Proposal', async () => {
    const { user, onPropose } = renderComposer(threeVoting().state());
    await choose(user, 'Cal');
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Make Cal steward (seat 1)');
    await choose(user, 'Ben');
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Make Ben steward (seat 1)');
    await fillWhy(user, 'Ben keeps things calm.');
    await user.click(screen.getByRole('button', { name: 'Propose this steward' }));
    expect(onPropose).toHaveBeenCalledTimes(1);
    expect(onPropose).toHaveBeenCalledWith({
      seat: 1,
      member: authorOf('ben'),
      title: 'Make Ben steward (seat 1)',
      why: 'Ben keeps things calm.',
    });
  });

  it('keeps a title the person typed when they choose someone else', async () => {
    const { user, onPropose } = renderComposer(threeVoting().state());
    await choose(user, 'Cal');
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Cal for steward');
    await choose(user, 'Ben');
    expect(title).toHaveValue('Cal for steward');
    await fillWhy(user, 'Either works.');
    await user.click(screen.getByRole('button', { name: 'Propose this steward' }));
    expect(onPropose).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cal for steward' }));
  });

  it('asks for a nominee and a why before queuing anything', async () => {
    const { user, onPropose } = renderComposer(threeVoting().state());
    await user.click(screen.getByRole('button', { name: 'Propose this steward' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(screen.getByText('Choose who you’re proposing.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers seat 2 at 6 voting members, without the holder of seat 1', () => {
    const state = groupLog({ members: ['Ben', 'Cal', 'Dee', 'Eve', 'Fay'] }).state();
    renderComposer(state, { seat: 2 });
    const nominees = screen.getByRole('radiogroup', { name: 'Who should hold this seat?' });
    expect(within(nominees).queryByRole('radio', { name: 'Ana' })).toBeNull();
    expect(within(nominees).getAllByRole('radio')).toHaveLength(5);
  });

  it('says why the long text didn’t send, and keeps the form, when it is too large', async () => {
    const { user } = renderComposer(threeVoting().state(), { outcome: 'too-large' });
    await choose(user, 'Ben');
    await fillWhy(user, 'Long.');
    await user.click(screen.getByRole('button', { name: 'Propose this steward' }));
    expect(screen.getByRole('textbox', { name: 'Why' })).toHaveAccessibleDescription(
      expect.stringContaining('This is too long to send.'),
    );
  });

  it('says so when the Proposal couldn’t be saved', async () => {
    const { user } = renderComposer(threeVoting().state(), { outcome: new Error('full') });
    await choose(user, 'Ben');
    await fillWhy(user, 'Calm.');
    await user.click(screen.getByRole('button', { name: 'Propose this steward' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your Proposal couldn’t be saved on this device. Try again.',
    );
  });

  it('proposes once when it is tapped again while it proposes and the save fails (#193)', async () => {
    const proposing = held<StewardOutcome>();
    const { user, onPropose } = renderComposer(threeVoting().state(), {
      outcome: proposing.promise,
    });
    await choose(user, 'Ben');
    await fillWhy(user, 'Calm.');
    const propose = screen.getByRole('button', { name: 'Propose this steward' });
    await user.click(propose);
    expect(propose).toBeDisabled();
    await user.click(propose);
    proposing.resolve('failed');
    expect(await screen.findByRole('alert')).toBeVisible();
    await pastPressFallback();
    expect(propose).toBeEnabled();
    expect(onPropose).toHaveBeenCalledTimes(1);
  });
});

describe('StewardComposer: Propose a recall', () => {
  it('names the steward it would remove, starts its title as the ballot line, and queues a recall', async () => {
    const { user, onPropose } = renderComposer(threeVoting().state(), { recall: true });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Propose a recall for seat 1' }),
    ).toBeVisible();
    const card = screen.getByText('On the ballot').parentElement;
    expect(card).toHaveTextContent('Recall Ana as steward');
    expect(card?.querySelector('bdi')).toHaveTextContent('Ana');
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Recall Ana as steward');
    expect(await axeViolations()).toEqual([]);
    await fillWhy(user, 'We talked it over.');
    await user.click(screen.getByRole('button', { name: 'Propose this recall' }));
    expect(onPropose).toHaveBeenCalledWith({
      seat: 1,
      member: null,
      title: 'Recall Ana as steward',
      why: 'We talked it over.',
    });
  });

  it('offers no recall of an empty seat', () => {
    renderComposer(threeVoting().state(), { recall: true, seat: 2 });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This seat can’t take a Proposal now' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propose this recall' })).toBeNull();
  });
});

describe('StewardComposer: when there is no form', () => {
  it('says the seat can’t take one at 2 voting members', () => {
    renderComposer(groupLog({ members: ['Ben'] }).state());
    expect(
      screen.getByRole('heading', { level: 1, name: 'This seat can’t take a Proposal now' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Riverside Tenants' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^#\/g\//),
    );
  });

  it('says it while another steward Proposal on the seat is open', () => {
    const log = threeVoting();
    log.steward('Cal', 1, 'Cal');
    renderComposer(log.state());
    expect(screen.getByText(/Another steward Proposal for this seat may be open/)).toBeVisible();
  });

  it('tells someone who can’t propose that their place here doesn’t include it', () => {
    const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING } });
    renderComposer(log.state(), { me: 'cal' });
    expect(screen.getByText('Your place in this group doesn’t include proposing.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propose this steward' })).toBeNull();
  });

  it('tells a suspended person until when, instead of a form', () => {
    const log = threeVoting();
    log.suspend('Ana', 'Ben', 'Threats.');
    renderComposer(log.state());
    const until = formatMinute(START_MINUTE + 7 * DAY_MINUTES);
    expect(
      screen.getByText(
        `A steward suspended you until ${until}. You can read, but not post, propose or vote.`,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propose this steward' })).toBeNull();
  });
});
