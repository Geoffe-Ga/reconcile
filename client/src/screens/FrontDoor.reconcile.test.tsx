/**
 * Propose reconciling with this group, on a front door's page (#426;
 * ADR-0077 §5): the button shows only on an open door and only for a device
 * with a group that may take a card, Send stays the page's one primary
 * action, and the form offers the person's groups as Bring a card's radio
 * does, then sends the card to the door.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { CardGroup, CardValues } from '../app/reconcile';
import { base64url } from '../crypto/base64url';
import { xchachaSeal } from '../crypto/seal';
import { CLOSED } from '../door/keeper';
import { addressOf, type OpenPage, publishPage } from '../door/page';
import { createRelay } from '../net/relay';
import { axeViolations } from '../test/axe';
import { DOOR } from '../test/door';
import { createFakeRelay } from '../test/fakeRelay';
import { held } from '../test/press';
import { FrontDoor } from './FrontDoor';
import type { DoorCardStep } from './ReconcileCard';

const { door, card } = messages;

/** A line of `parts` around the group's `name`, as the screen reads it. */
const around = (parts: { readonly before: string; readonly after: string }, name: string) =>
  `${parts.before} ${name}${parts.after}`;
const ADDRESS = addressOf(DOOR);
const PAYLOAD = base64url(ADDRESS);
const PAGE: OpenPage = {
  v: 1,
  open: true,
  name: 'Oak St Co-op',
  excerpt: 'We share tools and a garden.',
  box: base64url(new Uint8Array(32).fill(9)),
};
const RIVERSIDE: CardGroup = { groupId: 'g-riverside', name: 'Riverside Tenants', kind: 'group' };
const EASTSIDE: CardGroup = { groupId: 'g-eastside', name: '<b>Eastside</b>', kind: 'group' };

type MakeCard = (
  address: Uint8Array,
  page: OpenPage,
  groupId: string,
  values: CardValues,
) => Promise<DoorCardStep>;

/** The door's page over a fake relay, for a device holding `groups`. */
async function setup(
  groups: readonly CardGroup[],
  options: { readonly page?: OpenPage | typeof CLOSED; readonly step?: DoorCardStep } = {},
) {
  const fake = createFakeRelay();
  const reader = { relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal };
  if (options.page === CLOSED) await publishPage(reader, DOOR, PAGE, fake.minute);
  await publishPage(reader, DOOR, options.page ?? PAGE, fake.minute);
  const post = vi.fn(() => Promise.resolve());
  const onMakeCard = vi.fn<MakeCard>(() =>
    Promise.resolve(options.step ?? { kind: 'queued', proposalId: 'p-1', post }),
  );
  render(
    <FrontDoor
      payload={PAYLOAD}
      reader={reader}
      asked={() => false}
      onApply={() => Promise.resolve('sent')}
      documents={[]}
      takesDocuments={() => Promise.resolve(true)}
      cardGroups={groups}
      onMakeCard={onMakeCard}
    />,
  );
  return { user: userEvent.setup(), onMakeCard, post };
}

/** Fills the card's four fields. */
async function fill(user: ReturnType<typeof userEvent.setup>) {
  for (const [label, text] of [
    [card.nameLabel, 'Eastside Housing'],
    [card.whyLabel, 'We share a landlord.'],
    [card.yourNameLabel, 'Ana E.'],
  ] as const) {
    await user.click(screen.getByRole('textbox', { name: label }));
    await user.paste(text);
  }
  await user.click(screen.getByRole('textbox', { name: card.statementLabel }));
  await user.paste('Everyone has a safe home.');
}

describe('FrontDoor: Propose reconciling with this group (#426)', () => {
  it('shows the button on an open door for a device in a group, secondary beside Send, and passes axe', async () => {
    await setup([RIVERSIDE]);
    const button = await screen.findByRole('button', { name: door.proposeReconciling });
    expect(door.proposeReconciling).toBe('Propose reconciling with this group');
    expect(button).toHaveClass('button-secondary');
    expect(screen.getByRole('button', { name: door.send })).toHaveClass('button-primary');
    expect(document.querySelectorAll('.button-primary')).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows no button on a device in no group that may take a card', async () => {
    await setup([]);
    await screen.findByRole('heading', { level: 1, name: 'Oak St Co-op' });
    expect(screen.queryByRole('button', { name: door.proposeReconciling })).toBeNull();
  });

  it('shows no button on a closed door', async () => {
    await setup([RIVERSIDE], { page: CLOSED });
    expect(await screen.findByText(door.closed)).toBeVisible();
    expect(screen.queryByRole('button', { name: door.proposeReconciling })).toBeNull();
  });

  it('opens the card’s form for a group the person picks, the first to start, and sends it to this door', async () => {
    const { user, onMakeCard, post } = await setup([RIVERSIDE, EASTSIDE]);
    await user.click(await screen.findByRole('button', { name: door.proposeReconciling }));
    expect(await screen.findByRole('heading', { level: 1, name: card.doorTitle })).toBeVisible();
    expect(document.title).not.toContain('Oak St');
    const lede = screen.getByText((_text, node) => node?.className === 'lede');
    expect(lede).toHaveTextContent(around(card.doorLede, 'Oak St Co-op'));
    expect(within(lede).getByText('Oak St Co-op').tagName).toBe('BDI');
    const picker = screen.getByRole('radiogroup', { name: card.doorGroupLabel });
    expect(within(picker).getByRole('radio', { name: 'Riverside Tenants' })).toBeChecked();
    expect(within(picker).getByText('<b>Eastside</b>').tagName).toBe('BDI');
    expect(document.querySelector('b')).toBeNull();
    expect(await axeViolations()).toEqual([]);

    await user.click(within(picker).getByRole('radio', { name: '<b>Eastside</b>' }));
    await fill(user);
    await user.click(screen.getByRole('button', { name: card.doorSubmit }));
    expect(onMakeCard).toHaveBeenCalledTimes(1);
    const [[address, page, groupId, values]] = onMakeCard.mock.calls as [Parameters<MakeCard>];
    expect([base64url(address), page, groupId]).toEqual([PAYLOAD, PAGE, 'g-eastside']);
    expect(values).toEqual({
      name: 'Eastside Housing',
      statement: 'Everyone has a safe home.',
      why: 'We share a landlord.',
      yourName: 'Ana E.',
    });
    expect(post).toHaveBeenCalledTimes(1);
    const sent = await screen.findByRole('status');
    expect(sent).toHaveTextContent(around(card.doorSent, 'Oak St Co-op'));
    expect(within(sent).getByText('Oak St Co-op').tagName).toBe('BDI');
    expect(screen.getByRole('link', { name: card.proposalLink })).toHaveAttribute(
      'href',
      '#/g/g-eastside/p/p-1',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('refuses a statement too large to send, under the statement', async () => {
    const { user } = await setup([RIVERSIDE], { step: { kind: 'too-large' } });
    await user.click(await screen.findByRole('button', { name: door.proposeReconciling }));
    await fill(user);
    await user.click(screen.getByRole('button', { name: card.doorSubmit }));
    expect(await screen.findByText(card.tooLarge)).toBeVisible();
  });

  it('says when the card didn’t go, keeps the Proposal, and sends it again on Try again', async () => {
    const sending = held<undefined>();
    const post = vi.fn(() => sending.promise);
    const { user } = await setup([RIVERSIDE], {
      step: { kind: 'queued', proposalId: 'p-1', post },
    });
    await user.click(await screen.findByRole('button', { name: door.proposeReconciling }));
    await fill(user);
    await user.click(screen.getByRole('button', { name: card.doorSubmit }));
    expect(await screen.findByText(card.making)).toBeVisible();
    sending.reject();
    expect(await screen.findByRole('alert')).toHaveTextContent(card.failed);
    post.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole('button', { name: card.retry }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      around(card.doorSent, 'Oak St Co-op'),
    );
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('goes back to the door’s page without sending anything', async () => {
    const { user, onMakeCard } = await setup([RIVERSIDE]);
    await user.click(await screen.findByRole('button', { name: door.proposeReconciling }));
    await user.click(screen.getByRole('button', { name: card.doorBack }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Oak St Co-op' })).toBeVisible();
    expect(onMakeCard).not.toHaveBeenCalled();
  });
});
