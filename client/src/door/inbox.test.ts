/**
 * Tidying a front door's inbox on a member's device (#425, #426):
 * `forgetAnswered` with a stub store, so each branch shows. Reading the
 * inbox and Send an invite run through real devices in keeper.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import type { DoorInbox } from '../store/applications';
import { cardGoneAt } from './card';
import { type DoorDone, forgetAnswered } from './inbox';

const MINUTE = 29_000_000;
const CARD = { id: 'c1', seq: 2, received: MINUTE, seed: 'seed-c1' };
const HELD: DoorInbox = {
  inbox: 'inbox-1',
  cursor: 2,
  instance: 'i',
  applications: [],
  cards: [CARD],
};

/** A group state that has closed nothing, at relay minute `at`. */
const at = (minute: number): DoorDone => ({ doorInvites: [], doorCardsClosed: [], at: minute });

/** A store whose edit sees `current`, recording what it wrote. */
function storeOver(current: DoorInbox | undefined) {
  const written: (DoorInbox | undefined)[] = [];
  const updateInbox = vi.fn(
    (_groupId: string, edit: (held: DoorInbox | undefined) => DoorInbox | undefined) => {
      written.push(edit(current));
      return Promise.resolve();
    },
  );
  return { store: { updateInbox }, written };
}

describe('forgetAnswered', () => {
  it('writes nothing while no card is spent and no application answered', async () => {
    const { store } = storeOver(HELD);
    await forgetAnswered(store, 'g', HELD, at(cardGoneAt(MINUTE) - 1));
    expect(store.updateInbox).not.toHaveBeenCalled();
  });

  it('drops a card’s seed once the relay has surely dropped the card', async () => {
    const { store, written } = storeOver(HELD);
    await forgetAnswered(store, 'g', HELD, at(cardGoneAt(MINUTE)));
    expect(written).toEqual([{ ...HELD, cards: [{ id: 'c1', seq: 2, received: MINUTE }] }]);
  });

  it('drops a closed card’s seed', async () => {
    const { store, written } = storeOver(HELD);
    const closed = { id: 'e', seq: 3, received: MINUTE, by: 'ben', card: 'c1' };
    await forgetAnswered(store, 'g', HELD, { ...at(MINUTE), doorCardsClosed: [closed] });
    expect(written[0]?.cards).toEqual([{ id: 'c1', seq: 2, received: MINUTE }]);
  });

  it('leaves no inbox where the device holds none by the time it writes', async () => {
    const { store, written } = storeOver(undefined);
    await forgetAnswered(store, 'g', HELD, at(cardGoneAt(MINUTE)));
    expect(written).toEqual([undefined]);
  });
});
