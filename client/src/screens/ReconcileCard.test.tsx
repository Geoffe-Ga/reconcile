import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { CardValues } from '../app/reconcile';
import { axeViolations } from '../test/axe';
import { type CardStep, ReconcileCard, type ReconcileCardProps } from './ReconcileCard';

const LINK = 'https://reconcile.test/#reconcile/abc';

function props(overrides: Partial<ReconcileCardProps> = {}): ReconcileCardProps {
  return {
    groupId: 'riverside',
    groupName: 'Riverside Tenants',
    onMake: vi.fn(() =>
      Promise.resolve<CardStep>({
        kind: 'queued',
        proposalId: 'p1',
        post: () => Promise.resolve(LINK),
      }),
    ),
    copyText: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

/** Fills the form in: the name, the statement, why and your name. */
async function fillIn(user: ReturnType<typeof userEvent.setup>, name = 'Eastside Housing') {
  await user.type(screen.getByRole('textbox', { name: 'The coalition’s name' }), name);
  await user.type(
    screen.getByRole('textbox', { name: 'Its first statement' }),
    'One.{Enter}{Enter}Two.',
  );
  await user.type(screen.getByRole('textbox', { name: 'Why' }), 'We share a landlord.');
  await user.type(screen.getByRole('textbox', { name: 'Your name in the coalition' }), 'Ana E.');
}

describe('ReconcileCard, for a coalition (#122)', () => {
  it('goes back to the coalition, asks why of its groups, and leads on to its home with the coalition warning', async () => {
    const user = userEvent.setup();
    render(
      <ReconcileCard {...props({ groupName: 'Eastside Housing', coalitionId: 'eastside' })} />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: messages.card.coalitionTitle }),
    ).toBeVisible();
    expect(screen.getByText(messages.card.coalitionLede)).toBeVisible();
    expect(screen.getByText(messages.card.coalitionWhyHint)).toBeVisible();
    expect(screen.getByText(messages.card.coalitionNameHint)).toBeVisible();
    expect(screen.getByText(messages.card.coalitionStatementHint)).toBeVisible();
    expect(screen.queryByText(messages.card.statementHint)).toBeNull();
    expect(screen.getByRole('link', { name: /Eastside Housing/ })).toHaveAttribute(
      'href',
      '#/c/eastside',
    );
    await fillIn(user, 'Metro Renters');
    await user.click(screen.getByRole('button', { name: 'Make the card' }));
    expect(await screen.findByRole('textbox', { name: 'Card link' })).toHaveValue(LINK);
    expect(screen.getByText(messages.card.coalitionWarning)).toBeVisible();
    expect(screen.queryByText(messages.card.warning)).toBeNull();
    expect(screen.getByRole('link', { name: /Open your coalition/ })).toHaveAttribute(
      'href',
      '#/c/eastside',
    );
    expect(screen.queryByRole('link', { name: /Open your group’s Proposal/ })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});

describe('ReconcileCard', () => {
  it('sends the entries trimmed, then shows the link, Copy and the way to the Proposal', async () => {
    const user = userEvent.setup();
    const onMake = vi.fn<(values: CardValues) => Promise<CardStep>>(() => {
      return Promise.resolve<CardStep>({
        kind: 'queued',
        proposalId: 'p1',
        post: () => Promise.resolve(LINK),
      });
    });
    render(<ReconcileCard {...props({ onMake })} />);
    expect(screen.getByRole('link', { name: /Riverside Tenants/ })).toHaveAttribute(
      'href',
      '#/g/riverside',
    );
    await fillIn(user, '  Eastside Housing ');
    await user.click(screen.getByRole('button', { name: 'Make the card' }));

    expect(onMake).toHaveBeenCalledWith({
      name: 'Eastside Housing',
      statement: 'One.\n\nTwo.',
      why: 'We share a landlord.',
      yourName: 'Ana E.',
    });
    expect(await screen.findByRole('textbox', { name: 'Card link' })).toHaveValue(LINK);
    expect(screen.getByRole('link', { name: /Open your group’s Proposal/ })).toHaveAttribute(
      'href',
      '#/g/riverside/p/p1',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('refuses a name over 120 characters and a statement too large to send', async () => {
    const user = userEvent.setup();
    const onMake = vi.fn(() => Promise.resolve<CardStep>({ kind: 'too-large' }));
    render(<ReconcileCard {...props({ onMake })} />);
    await fillIn(user, 'n'.repeat(121));
    await user.click(screen.getByRole('button', { name: 'Make the card' }));
    expect(onMake).not.toHaveBeenCalled();
    expect(
      screen.getByRole('textbox', { name: 'The coalition’s name' }),
    ).toHaveAccessibleDescription(`${messages.card.nameHint} ${messages.card.nameTooLong(120)}`);

    const name = screen.getByRole('textbox', { name: 'The coalition’s name' });
    await user.clear(name);
    await user.type(name, 'Eastside');
    await user.click(screen.getByRole('button', { name: 'Make the card' }));
    expect(await screen.findByText(messages.card.tooLarge)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Card link' })).not.toBeInTheDocument();
  });

  it('refuses a blank statement and a why over 2,000 characters', async () => {
    const user = userEvent.setup();
    const onMake = vi.fn();
    render(<ReconcileCard {...props({ onMake })} />);
    await user.type(screen.getByRole('textbox', { name: 'The coalition’s name' }), 'Eastside');
    await user.click(screen.getByRole('textbox', { name: 'Why' }));
    await user.paste('w'.repeat(2001));
    await user.type(screen.getByRole('textbox', { name: 'Your name in the coalition' }), 'Ana');
    await user.click(screen.getByRole('button', { name: 'Make the card' }));

    expect(onMake).not.toHaveBeenCalled();
    expect(screen.getByText(messages.card.statementMissing)).toBeVisible();
    expect(screen.getByText(messages.card.whyTooLong(2000))).toBeVisible();
  });

  it('says there’s no card yet when posting fails, and Try again posts the same one', async () => {
    const user = userEvent.setup();
    const post = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(LINK);
    const onMake = vi.fn(() =>
      Promise.resolve<CardStep>({ kind: 'queued', proposalId: 'p1', post }),
    );
    render(<ReconcileCard {...props({ onMake })} />);
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Make the card' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.card.failed);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('textbox', { name: 'Card link' })).toHaveValue(LINK);
    expect(onMake).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('says it’s making the card while the relay takes it, and takes one submit at a time', async () => {
    const user = userEvent.setup();
    let finish: (link: string) => void = () => undefined;
    const post = () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      });
    let queue: (step: CardStep) => void = () => undefined;
    const onMake = vi.fn(
      () =>
        new Promise<CardStep>((resolve) => {
          queue = resolve;
        }),
    );
    render(<ReconcileCard {...props({ onMake })} />);
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Make the card' }));
    await user.click(screen.getByRole('button', { name: 'Make the card' }));
    expect(onMake).toHaveBeenCalledOnce();
    queue({ kind: 'queued', proposalId: 'p1', post });

    expect(await screen.findByRole('status')).toHaveTextContent(messages.card.making);
    finish(LINK);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your card is ready' }),
    ).toBeVisible();
  });
});
