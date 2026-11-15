import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import type { CoalitionRow } from './coalitionLines';
import { CoalitionSection, type CoalitionSectionProps } from './CoalitionSection';
import { messages } from './messages';
import { SectionGlyph } from './SectionGlyph';
import type { WebShare } from './share';

const ROW: CoalitionRow = {
  entryId: 'entry-1',
  proposal: 'proposal-1',
  coalitionId: 'coalition-1',
  name: 'Eastside Housing',
  status: 'formed',
  lines: [],
  members: ['Riverside Tenants', 'Oak St Co-op'],
  me: { kind: 'in', name: 'Ana E.' },
  makesCards: true,
  reconciles: false,
  mismatches: 0,
  above: [],
};

function props(overrides: Partial<CoalitionSectionProps> = {}): CoalitionSectionProps {
  return {
    groupId: 'group-1',
    rows: [ROW],
    starts: true,
    onTakePart: vi.fn(() => Promise.resolve()),
    makeCardLink: vi.fn(() => Promise.resolve('https://reconcile.test/#reconcile/abc')),
    copyText: vi.fn(() => Promise.resolve()),
    sharing: { share: undefined },
    ...overrides,
  };
}

const section = () => screen.getByRole('region', { name: 'Coalitions' });

beforeEach(() => {
  document.title = 'Riverside Tenants · Reconcile';
});

describe('CoalitionSection, nested (#122)', () => {
  const ABOVE: CoalitionRow['above'] = [
    {
      key: 'seat-c',
      name: 'Metro Renters',
      coalitionId: 'metro-1',
      status: 'formed',
      lines: [],
      chain: ['Riverside Tenants', 'Eastside Housing', 'Metro Renters'],
    },
    {
      key: 'seat-d',
      name: 'State Renters',
      coalitionId: null,
      status: 'forming',
      lines: [{ kind: 'waiting', group: 'Grove' }],
      chain: ['Riverside Tenants', 'Eastside Housing', 'Metro Renters', 'State Renters'],
    },
  ];

  it('lists the coalitions above one, each with its chain, its standing and its home once formed', async () => {
    render(<CoalitionSection {...props({ rows: [{ ...ROW, above: ABOVE }] })} />);
    const above = within(section()).getByRole('list', { name: messages.coalitions.above });
    const [metro, state] = within(above).getAllByRole('listitem');
    expect(metro).toHaveTextContent(
      'FormedRiverside Tenants · in Eastside Housing · in Metro RentersOpen the coalition→',
    );
    expect(
      within(metro as HTMLElement).getByRole('link', { name: 'Open the coalition' }),
    ).toHaveAttribute('href', '#/c/metro-1');
    expect(state).toHaveTextContent(
      'FormingRiverside Tenants · in Eastside Housing · in Metro Renters · in State RentersWaiting for Grove’s vote',
    );
    expect(within(state as HTMLElement).queryByRole('link')).toBeNull();
    expect(within(metro as HTMLElement).getByText('Metro Renters').tagName).toBe('BDI');
    expect(await axeViolations()).toEqual([]);
  });

  it('offers Reconcile with another coalition only to whoever may make its card', () => {
    const { unmount } = render(
      <CoalitionSection {...props({ rows: [{ ...ROW, reconciles: true }] })} />,
    );
    const link = within(section()).getByRole('link', { name: /Reconcile with another coalition/ });
    expect(link).toHaveAttribute('href', '#/c/coalition-1/reconcile');
    unmount();
    render(<CoalitionSection {...props()} />);
    expect(within(section()).queryByRole('link', { name: /another coalition/ })).toBeNull();
    expect(within(section()).queryByRole('list', { name: messages.coalitions.above })).toBeNull();
  });
});

describe('CoalitionSection', () => {
  it('shows a formed coalition, its member groups and how this person takes part', async () => {
    render(<CoalitionSection {...props()} />);

    expect(section()).toHaveTextContent(
      'CoalitionsFormedEastside HousingRiverside Tenants, Oak St Co-opOpen the coalition→You take part as Ana E.',
    );
    const home = within(section()).getByRole('link', { name: 'Open the coalition' });
    expect(home).toHaveAttribute('href', '#/c/coalition-1');
    expect(
      within(section()).getByRole('heading', { level: 3, name: 'Eastside Housing' }),
    ).toBeVisible();
    const start = within(section()).getByRole('link', { name: /Reconcile with another group/ });
    expect(start).toHaveAttribute('href', '#/g/group-1/reconcile');
    expect(await axeViolations()).toEqual([]);
  });

  it('says whom a forming coalition waits for, who didn’t pass it, and any mismatch', () => {
    const row: CoalitionRow = {
      ...ROW,
      status: 'forming',
      members: [],
      makesCards: false,
      me: { kind: 'joining' },
      mismatches: 2,
      lines: [
        { kind: 'waiting', group: 'Oak St Co-op' },
        { kind: 'didnt-pass', group: 'Elm Row' },
        { kind: 'waiting-card' },
        { kind: 'lapsed' },
      ],
    };
    render(<CoalitionSection {...props({ rows: [row], starts: false })} />);

    expect(section()).toHaveTextContent('Waiting for Oak St Co-op’s vote');
    expect(section()).toHaveTextContent('Elm Row didn’t pass this');
    expect(section()).toHaveTextContent(messages.coalitions.waitingCard);
    expect(section()).toHaveTextContent(messages.coalitions.lapsed);
    expect(section()).toHaveTextContent(messages.coalitions.mismatch);
    expect(section()).toHaveTextContent(messages.coalitions.joining);
    expect(within(section()).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows nothing with no coalition and nothing to start, and the start link alone with none yet', () => {
    const { container, rerender } = render(
      <CoalitionSection {...props({ rows: [], starts: false })} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<CoalitionSection {...props({ rows: [] })} />);
    expect(section()).toHaveTextContent('CoalitionsReconcile with another group→');
  });

  it('opens its heading with the coalitions glyph, hidden from assistive tech', () => {
    render(<CoalitionSection {...props()} />);
    const heading = within(section()).getByRole('heading', { level: 2, name: 'Coalitions' });
    const glyph = heading.querySelector('svg');
    expect(glyph).toHaveClass('section-glyph');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.getAttribute('focusable')).toBe('false');
    expect(glyph?.innerHTML).toBe(
      render(<SectionGlyph kind="coalitions" />).container.querySelector('svg')?.innerHTML,
    );
  });

  it('takes part under a name, and says so when that didn’t save', async () => {
    const user = userEvent.setup();
    const onTakePart = vi
      .fn<CoalitionSectionProps['onTakePart']>()
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValue(undefined);
    const row: CoalitionRow = { ...ROW, makesCards: false, me: { kind: 'may-take-part' } };
    render(<CoalitionSection {...props({ rows: [row], onTakePart })} />);

    await user.click(screen.getByRole('button', { name: 'Take part' }));
    expect(onTakePart).not.toHaveBeenCalled();
    const name = screen.getByRole('textbox', { name: 'Your name in the coalition' });
    expect(name).toHaveAccessibleDescription(
      'This name is only shown in this coalition. Add the name the coalition will see.',
    );
    await user.type(name, '  Ana E. ');
    await user.click(screen.getByRole('button', { name: 'Take part' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(messages.coalitions.takePartFailed);
    await user.click(screen.getByRole('button', { name: 'Take part' }));
    expect(onTakePart).toHaveBeenLastCalledWith('entry-1', 'Ana E.');
    expect(onTakePart).toHaveBeenCalledTimes(2);
  });

  it('makes a card for another group, and shows its link beside the warning once the relay has it', async () => {
    const user = userEvent.setup();
    const makeCardLink = vi
      .fn<CoalitionSectionProps['makeCardLink']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('https://reconcile.test/#reconcile/abc');
    const copyText = vi.fn(() => Promise.resolve());
    render(<CoalitionSection {...props({ makeCardLink, copyText })} />);

    const make = screen.getByRole('button', { name: messages.card.another });
    expect(make).toHaveAccessibleDescription(messages.card.anotherLede);
    await user.click(make);
    expect(await screen.findByText(messages.card.failedAnother)).toBeVisible();
    await user.click(make);
    const link = await screen.findByRole('textbox', { name: 'Card link' });
    expect(link).toHaveValue('https://reconcile.test/#reconcile/abc');
    expect(link).toHaveAccessibleDescription(messages.card.warning);
    expect(makeCardLink).toHaveBeenCalledWith('entry-1');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copyText).toHaveBeenCalledWith('https://reconcile.test/#reconcile/abc');
    expect(await axeViolations()).toEqual([]);
  });

  it('puts Share beside Copy on the card it made, sharing the link alone (#424)', async () => {
    const user = userEvent.setup();
    const share = vi.fn<WebShare>(() => Promise.resolve());
    const copyText = vi.fn(() => Promise.resolve());
    render(<CoalitionSection {...props({ sharing: { share }, copyText })} />);

    await user.click(screen.getByRole('button', { name: messages.card.another }));
    expect(await screen.findByRole('textbox', { name: 'Card link' })).toBeVisible();
    const shareButton = screen.getByRole('button', { name: messages.linkShare.button });
    expect(shareButton).toHaveClass('button-secondary');
    expect(shareButton).toHaveAccessibleDescription(messages.linkShare.chatNote);
    expect(await axeViolations()).toEqual([]);

    await user.click(shareButton);
    expect(share.mock.calls).toEqual([[{ url: 'https://reconcile.test/#reconcile/abc' }]]);
    expect(copyText).not.toHaveBeenCalled();
    expect(await within(section()).findByText(messages.linkShare.shared)).toBeVisible();
  });

  it('makes one card at a time', async () => {
    const user = userEvent.setup();
    let finish: (link: string) => void = () => undefined;
    const makeCardLink = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    render(<CoalitionSection {...props({ makeCardLink })} />);

    const make = screen.getByRole('button', { name: messages.card.another });
    await user.click(make);
    expect(screen.getByRole('status')).toHaveTextContent(messages.card.making);
    await user.click(make);
    expect(makeCardLink).toHaveBeenCalledOnce();
    finish('https://reconcile.test/#reconcile/abc');
    expect(await screen.findByRole('textbox', { name: 'Card link' })).toBeVisible();
  });

  it('shows no way in for someone who neither takes part nor may', () => {
    const row: CoalitionRow = { ...ROW, makesCards: false, me: { kind: 'none' } };
    render(<CoalitionSection {...props({ rows: [row] })} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(section()).not.toHaveTextContent('You take part');
  });
});
