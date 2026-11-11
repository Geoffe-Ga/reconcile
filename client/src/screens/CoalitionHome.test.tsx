import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { CoalitionHomeView, MotionItem } from '../app/coalitionHome';
import { formatDay } from '../app/format';
import { messages } from '../app/messages';
import type { CoalitionProgress } from '../engine/coalitionProgress';
import { axeViolations } from '../test/axe';
import { CoalitionHome, type CoalitionHomeProps } from './CoalitionHome';

const NOW = 29_400_000;

const OPEN: CoalitionProgress = {
  seats: 2,
  passed: 1,
  failed: 0,
  needed: 2,
  deciding: ['Oak St Co-op'],
  groups: [],
  final: false,
  settles: NOW + 20_000,
};

/** A motion on the coalition home, open unless `progress` says otherwise. */
function motion(id: string, overrides: Partial<MotionItem> = {}): MotionItem {
  return {
    id,
    title: 'Paths too',
    deadline: NOW + 5_000,
    closedAt: null,
    decidedAt: NOW + 15_000,
    progress: OPEN,
    groupId: 'riverside',
    ...overrides,
  };
}

const VIEW: CoalitionHomeView = {
  coalitionId: 'coalition-1',
  entryId: 'entry-1',
  name: 'Eastside Housing',
  members: [
    { name: 'Riverside Tenants', mine: true, coalition: false },
    { name: 'Oak St Co-op', mine: false, coalition: false },
  ],
  documents: [{ id: 'coalition-1', title: 'Mission statement' }],
  open: [motion('m1')],
  decided: [],
  pending: [],
  standing: { kind: 'proposes', groupId: 'riverside' },
  dispatches: [],
};

function props(overrides: Partial<CoalitionHomeProps> = {}): CoalitionHomeProps {
  return {
    view: VIEW,
    now: NOW,
    back: { groupId: 'riverside', name: 'Riverside Tenants' },
    onTakePart: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

const region = (name: string) => screen.getByRole('region', { name });

describe('CoalitionHome, with a coalition among its members (#122)', () => {
  it('marks a member coalition, and says Your coalition for one this device takes part through', async () => {
    const members = [
      { name: 'Eastside Housing', mine: true, coalition: true },
      { name: 'Hill Coalition', mine: false, coalition: true },
      { name: 'Elm Row', mine: false, coalition: false },
    ];
    render(<CoalitionHome {...props({ view: { ...VIEW, name: 'Metro Renters', members } })} />);
    const list = screen.getByRole('region', { name: messages.coalitions.groups });
    const [eastside, hill, elm] = within(list).getAllByRole('listitem');
    expect(eastside).toHaveTextContent(`Eastside Housing${messages.coalitions.yourCoalition}`);
    expect(hill).toHaveTextContent(`Hill Coalition${messages.coalitions.coalitionSeat}`);
    expect(elm).toHaveTextContent(/^Elm Row$/);
    expect(await axeViolations()).toEqual([]);
  });
});

describe('CoalitionHome’s Dispatches (#126)', () => {
  it('lists what the coalition passed and sent out, newest first, each from the seat that passed it', async () => {
    const dispatches = [
      { id: 'd2', title: 'Rent strike vote', text: '', from: 'Oak St Co-op', received: NOW - 60 },
      {
        id: 'd1',
        title: 'Rally Saturday',
        text: 'Meet at the river at ten.\nBring water.',
        from: 'Riverside Tenants',
        received: NOW - 4_000,
      },
    ];
    render(<CoalitionHome {...props({ view: { ...VIEW, dispatches } })} />);
    const list = region(messages.dispatches.title);
    const cards = within(list).getAllByRole('article');
    expect(
      cards.map((card) => within(card).getByRole('heading', { level: 3 }).textContent),
    ).toEqual(['Rent strike vote', 'Rally Saturday']);
    const [, rally] = cards;
    if (rally === undefined) throw new Error('Expected the second card.');
    expect(rally).toHaveTextContent(`From Riverside Tenants,·${formatDay(NOW - 4_000)}`);
    expect(within(rally).getByText(/Meet at the river/).textContent).toBe(
      'Meet at the river at ten.\nBring water.',
    );
    expect(within(cards[0] ?? rally).queryByText(/Meet at the river/)).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('says there are none yet', () => {
    render(<CoalitionHome {...props()} />);
    expect(region(messages.dispatches.title)).toHaveTextContent(messages.dispatches.empty);
  });
});

describe('CoalitionHome', () => {
  it('names the coalition and lists its open Proposals, Documents, Decided and member groups', async () => {
    render(<CoalitionHome {...props()} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Eastside Housing' })).toBeVisible();
    expect(document.title).toBe('Coalition · Reconcile');
    const back = screen.getByRole('link', { name: /Riverside Tenants/ });
    expect(back).toHaveAttribute('href', '#/g/riverside');

    const open = within(region('Open Proposals')).getByRole('link', { name: /Paths too/ });
    expect(open).toHaveAttribute('href', '#/g/riverside/p/m1');
    expect(open).toHaveTextContent('1 of 2 groups has passed. Waiting for Oak St Co-op.');
    expect(open).toHaveTextContent('Closes in 3 days');

    const documents = within(region('Documents')).getByRole('link', { name: /Mission statement/ });
    expect(documents).toHaveAttribute('href', '#/c/coalition-1/doc/coalition-1');
    expect(region('Decided')).toHaveTextContent(messages.decided.empty);

    const groups = within(region('Member groups')).getAllByRole('listitem');
    expect(groups.map((item) => item.textContent)).toEqual([
      'Riverside TenantsYour group',
      'Oak St Co-op',
    ]);
    expect(screen.queryByRole('region', { name: 'Take part' })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('lists decided motions with whether the coalition passed them and the day it decided', () => {
    const passed = motion('m2', {
      title: 'Banks too',
      progress: { ...OPEN, passed: 2, deciding: [], outcome: 'pass', final: true },
    });
    const failed = motion('m3', {
      title: 'Bridges too',
      groupId: null,
      decidedAt: NOW - 1_440,
      progress: { ...OPEN, failed: 1, deciding: [], outcome: 'fail', final: true },
    });
    render(
      <CoalitionHome {...props({ view: { ...VIEW, open: [], decided: [passed, failed] } })} />,
    );

    const decided = region('Decided');
    const link = within(decided).getByRole('link', { name: /Banks too/ });
    expect(link).toHaveTextContent(`Passed${formatDay(NOW + 15_000)}`);
    // A motion no group on this device decides has no vote to open here.
    expect(within(decided).queryByRole('link', { name: /Bridges too/ })).not.toBeInTheDocument();
    expect(decided).toHaveTextContent(`Bridges tooDidn’t pass${formatDay(NOW - 1_440)}`);
    expect(region('Open Proposals')).toHaveTextContent(messages.coalitions.noOpen);
  });

  it('gives a decided motion’s outcome sentence in place of its countdown, while it waits to be final', () => {
    const passed = motion('m4', {
      progress: { ...OPEN, passed: 2, deciding: [], outcome: 'pass', final: false },
    });
    render(<CoalitionHome {...props({ view: { ...VIEW, open: [passed] } })} />);
    const card = within(region('Open Proposals')).getByRole('link', { name: /Paths too/ });
    expect(card).toHaveTextContent('The coalition passed this. It takes effect on');
    expect(card).not.toHaveTextContent('Closes');
  });

  it('lists a Proposal this device sent while it waits for the relay', () => {
    const view = { ...VIEW, open: [], pending: [{ id: 'p1', title: 'Paths too' }] };
    render(<CoalitionHome {...props({ view })} />);
    expect(region('Open Proposals')).toHaveTextContent(`Paths too${messages.coalitions.pending}`);
  });

  it('offers Take part first to someone who may propose in a member group and hasn’t joined', async () => {
    const user = userEvent.setup();
    const onTakePart = vi.fn(() => Promise.resolve());
    const view: CoalitionHomeView = { ...VIEW, standing: { kind: 'take-part', groupId: 'r' } };
    render(<CoalitionHome {...props({ view, onTakePart, back: null })} />);

    expect(screen.getByRole('link', { name: /Your groups/ })).toHaveAttribute('href', '#/');
    const takePart = region('Take part');
    expect(takePart).toHaveTextContent(messages.coalitions.takePartFirst);
    await user.type(within(takePart).getByRole('textbox'), 'Ana E.');
    await user.click(within(takePart).getByRole('button', { name: 'Take part' }));
    expect(onTakePart).toHaveBeenCalledWith('Ana E.');
    expect(await axeViolations()).toEqual([]);
  });
});
