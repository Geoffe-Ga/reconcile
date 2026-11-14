/**
 * Groups asking to reconcile, under Applications (#426; ADR-0077 §5): each
 * reconcile card left at the door, its preview as plain text as Bring a card
 * shows it, the day it arrived, Bring it to a vote and Dismiss for someone
 * who may propose; "This card has expired." with Dismiss only once its day
 * has run out; and nothing once a member has closed it.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { CardLookup, FoundCard } from '../app/reconcile';
import { base64url } from '../crypto/base64url';
import { cardGoneAt } from '../door/card';
import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import type { ReceivedCard } from '../store/applications';
import { axeViolations } from '../test/axe';
import { DOOR } from '../test/door';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { Applications, type DoorCards } from './Applications';

const { door, bring } = messages;
const [, VOTING] = LEVELS;

/** An id or seed: 32 repeated `byte`s, in unpadded base64url. */
const bytes32 = (byte: number) => base64url(new Uint8Array(32).fill(byte));

/** Ana, Ben and Cal's group with the door open; Cal votes but doesn't propose. */
function opened() {
  const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING } });
  const open = log.rules('Ana', 'frontDoor', DOOR);
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
  log.minute += 1;
  return log;
}

/** A card that arrived at relay minute `received`. */
function cardAt(byte: number, received: number): ReceivedCard {
  return { id: bytes32(byte), seq: byte, received, seed: bytes32(byte + 1) };
}

/** Eastside Housing's card from Riverside Tenants, as a lookup finds it for `state`'s group. */
function foundFor(state: GroupState): FoundCard {
  return {
    card: {
      secret: new Uint8Array(32).fill(7),
      seat: { name: '<i>Riverside</i> Tenants', key: bytes32(8) },
      name: 'Eastside Housing',
      title: 'Mission statement',
      atoms: ['Everyone on the east side has a safe home.', 'See [us](https://x.test).'],
      entries: [],
    },
    mode: 'found',
    log: { records: [], cursor: 0, relayNow: state.at, instance: 'i' },
    groups: [{ groupId: state.group ?? '', name: 'Riverside Tenants', kind: 'group' }],
  };
}

interface Options {
  readonly me?: string;
  readonly lookup?: (state: GroupState) => CardLookup;
}

function setup(state: GroupState, held: readonly ReceivedCard[], options: Options = {}) {
  const lookup = vi.fn((_seed: Uint8Array) =>
    Promise.resolve(options.lookup?.(state) ?? { kind: 'found' as const, found: foundFor(state) }),
  );
  const onBring = vi.fn((_card: string, _found: FoundCard, _name: string) => Promise.resolve(true));
  const onDismiss = vi.fn((_card: string) => Promise.resolve());
  const cards: DoorCards = { held, lookup, onBring, onDismiss };
  document.title = 'Your group · Reconcile';
  render(
    <main>
      <Applications
        state={state}
        me={authorOf(options.me ?? 'ben')}
        applications={[]}
        onInvite={() => Promise.resolve('sent')}
        onDismiss={() => Promise.resolve()}
        cards={cards}
      />
    </main>,
  );
  return { user: userEvent.setup(), lookup, onBring, onDismiss };
}

/** The list of cards under "Groups asking to reconcile". */
function cardList(): HTMLElement {
  return screen.getByRole('list', { name: door.cardsHeading });
}

describe('Applications: Groups asking to reconcile (#426)', () => {
  it('lists each card’s preview as plain text, the day it arrived, then Bring it to a vote and Dismiss, and passes axe', async () => {
    const log = opened();
    const state = log.state();
    const { lookup } = setup(state, [cardAt(0xc1, state.at)]);
    expect(screen.getByRole('heading', { level: 3, name: door.cardsHeading })).toBeVisible();
    expect(door.cardsHeading).toBe('Groups asking to reconcile');
    const row = within(cardList()).getByRole('listitem');
    expect(await within(row).findByText('Eastside Housing')).toBeVisible();
    expect(lookup).toHaveBeenCalledWith(new Uint8Array(32).fill(0xc2));
    expect(within(row).getByText('<i>Riverside</i> Tenants').tagName).toBe('BDI');
    expect(row).toHaveTextContent(`${bring.from} <i>Riverside</i> Tenants`);
    expect(within(row).getByText('See [us](https://x.test).')).toBeVisible();
    expect(row.querySelector('i, a')).toBeNull();
    expect(row.querySelector('time')?.textContent).toMatch(/^Arrived \w{3} \d{1,2} \w{3}$/);
    const bringIt = within(row).getByRole('button', {
      name: 'Bring it to a vote for Eastside Housing',
    });
    expect(bringIt).toHaveClass('button-secondary');
    const dismiss = within(row).getByRole('button', {
      name: 'Dismiss the card for Eastside Housing',
    });
    expect(dismiss).toHaveClass('button-quiet');
    expect(dismiss).toHaveAccessibleDescription(door.dismissCardHint);
    // No count, no badge: a card arrives quietly.
    expect(screen.queryByText(/\(\d+\)|\b1 new\b/)).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('brings it to a vote for this group under the name given in the coalition', async () => {
    const state = opened().state();
    const held = cardAt(0xc1, state.at);
    const { user, onBring } = setup(state, [held]);
    const row = within(cardList()).getByRole('listitem');
    const bringIt = await within(row).findByRole('button', { name: /^Bring it to a vote/ });
    await user.click(bringIt);
    expect(await within(row).findByText(bring.yourNameMissing)).toBeVisible();
    expect(onBring).not.toHaveBeenCalled();
    await user.click(within(row).getByRole('textbox', { name: bring.yourNameLabel }));
    await user.paste(' Ben O. ');
    await user.click(bringIt);
    expect(onBring).toHaveBeenCalledTimes(1);
    const [[id, found, name]] = onBring.mock.calls as [[string, FoundCard, string]];
    expect([id, found.card.name, name]).toEqual([held.id, 'Eastside Housing', 'Ben O.']);
  });

  it('says when bringing it didn’t finish, and offers it again', async () => {
    const state = opened().state();
    const { user, onBring } = setup(state, [cardAt(0xc1, state.at)]);
    onBring.mockResolvedValueOnce(false);
    const row = within(cardList()).getByRole('listitem');
    await user.click(await within(row).findByRole('textbox', { name: bring.yourNameLabel }));
    await user.paste('Ben');
    await user.click(within(row).getByRole('button', { name: /^Bring it to a vote/ }));
    expect(await within(row).findByRole('alert')).toHaveTextContent(bring.failed);
    expect(within(row).getByRole('button', { name: /^Bring it to a vote/ })).toBeEnabled();
  });

  it('dismisses it for the whole group', async () => {
    const state = opened().state();
    const held = cardAt(0xc1, state.at);
    const { user, onDismiss } = setup(state, [held]);
    const row = within(cardList()).getByRole('listitem');
    const dismiss = await within(row).findByRole('button', {
      name: 'Dismiss the card for Eastside Housing',
    });
    await user.click(dismiss);
    expect(onDismiss).toHaveBeenCalledWith(held.id);
  });

  it('reads "This card has expired." with Dismiss only once its day has run out, asking the relay nothing', async () => {
    const state = opened().state();
    const day = 1440;
    const gone = cardAt(0xc1, state.at - 2 * day);
    expect(cardGoneAt(gone.received)).toBeLessThanOrEqual(state.at);
    const seedless: ReceivedCard = { id: bytes32(0xc3), seq: 9, received: state.at };
    const { lookup } = setup(state, [gone, seedless]);
    const rows = within(cardList()).getAllByRole('listitem');
    for (const row of rows) {
      expect(within(row).getByText(door.cardExpired)).toBeVisible();
      expect(
        within(row)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual([expect.stringMatching(/^Dismiss/) as string]);
    }
    expect(door.cardExpired).toBe('This card has expired.');
    expect(lookup).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('reads a card the relay no longer holds as expired, and one already used as used', async () => {
    const state = opened().state();
    setup(state, [cardAt(0xc1, state.at)], { lookup: () => ({ kind: 'missing' }) });
    expect(await screen.findByText(door.cardExpired)).toBeVisible();
  });

  it('reads a used card as used, with Dismiss only', async () => {
    const state = opened().state();
    setup(state, [cardAt(0xc1, state.at)], { lookup: () => ({ kind: 'used' }) });
    const row = within(cardList()).getByRole('listitem');
    expect(await within(row).findByText(bring.used)).toBeVisible();
    expect(within(row).queryByRole('button', { name: /^Bring/ })).toBeNull();
  });

  it('says when the relay can’t be reached, with Dismiss', async () => {
    const state = opened().state();
    setup(state, [cardAt(0xc1, state.at)], { lookup: () => ({ kind: 'offline' }) });
    expect(await screen.findByText(door.cardOffline)).toBeVisible();
    expect(screen.getByRole('button', { name: /^Dismiss the card/ })).toBeVisible();
  });

  it('offers Dismiss only where the group already holds this card', async () => {
    const state = opened().state();
    setup(state, [cardAt(0xc1, state.at)], {
      lookup: (folded) => ({ kind: 'found', found: { ...foundFor(folded), groups: [] } }),
    });
    const row = within(cardList()).getByRole('listitem');
    expect(await within(row).findByText('Eastside Housing')).toBeVisible();
    expect(within(row).queryByRole('button', { name: /^Bring/ })).toBeNull();
    expect(within(row).getByRole('button', { name: /^Dismiss the card/ })).toBeVisible();
  });

  it('shows a member who can’t propose the card, with nothing to press', async () => {
    const state = opened().state();
    setup(state, [cardAt(0xc1, state.at)], { me: 'cal' });
    const row = within(cardList()).getByRole('listitem');
    expect(await within(row).findByText('Eastside Housing')).toBeVisible();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(within(row).queryByRole('textbox')).toBeNull();
  });

  it('shows no card a member has closed, and no heading when none is left', () => {
    const log = opened();
    const closed = cardAt(0xc1, log.minute);
    log.doorCardClosed('Ben', closed.id);
    setup(log.state(), [closed]);
    expect(screen.queryByRole('heading', { name: door.cardsHeading })).toBeNull();
    expect(screen.queryByRole('list', { name: door.cardsHeading })).toBeNull();
  });
});
