/**
 * The recovery picker (#109) in a removal's window (#360, #115): after the
 * removal's pass is final, and before any device's `remove` lands. The fold
 * already treats the person it names as out (`isOusted`): they only read,
 * and it ignores their `recovery-share`. So the picker leaves them out as
 * someone else's contact, and offers them none of that group's people.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { xchachaSeal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, testKeys } from '../test/keys';
import { groupLog, type LogBuilder } from '../test/votes';
import { openStore, type Store } from './db';
import { eventIdOf } from './eventId';
import { chooseContacts, contactGroups, type RecoveryServices } from './recovery';
import { createSync, type Sync } from './sync';

freshIndexedDBPerTest();

/** The device clock, in milliseconds. */
const TS = 1_762_650_000_000;
const stores: Store[] = [];
const syncs: Sync[] = [];

afterEach(() => {
  for (const sync of syncs.splice(0)) sync.stop();
  for (const store of stores.splice(0)) store.close();
});

/** Riverside: Ana, Ben, Cal and Dee, each with an encryption key, and Ana's Proposal to remove Cal. */
function riverside() {
  const log = groupLog({ members: ['Ben', 'Cal', 'Dee'], kx: true });
  const removal = log.proposeRemoval('Ana', 'Cal');
  log.vote('Ana', removal, 4);
  log.vote('Ben', removal, 4);
  return { log, removal };
}

/** Dee's ballot, the last of the removal's eligible set, and a minute on: its pass is final, and no `remove` has come. */
function passes(log: LogBuilder, removal: string): void {
  log.vote('Dee', removal, 4);
  log.minute += 1;
}

/** `name`'s device holding the group as `log` stands, in a database of its own. */
async function deviceOf(name: string, log: LogBuilder): Promise<Store> {
  const store = await openStore(`picker-${name}-${String(stores.length)}`);
  stores.push(store);
  const { secretKey } = testKeys(name.toLowerCase());
  await store.addGroup({
    groupId: log.group,
    secret: new Uint8Array(32).fill(9),
    signingKey: secretKey,
    me: { author: authorOf(name.toLowerCase()), name },
  });
  const pull = { records: [...log.records], relayNow: log.minute, instance: 'i', lastSyncAt: 1 };
  await store.applyPull(log.group, pull, eventIdOf);
  return store;
}

/** What the picker on `name`'s device lists: each group's name, with the people it offers there. */
async function pickerOf(name: string, log: LogBuilder) {
  const groups = contactGroups(await (await deviceOf(name, log)).listGroups());
  return groups.map((group) => [group.name, group.members.map((person) => person.name)]);
}

describe('the recovery picker once a removal has passed, before its `remove` lands (#360)', () => {
  it('leaves out the person the removal names, and refuses them as a contact', async () => {
    const { log, removal } = riverside();
    // The control: while the removal is open, Cal is anyone's contact to pick.
    expect(await pickerOf('Ana', log)).toEqual([['Riverside Tenants', ['Ben', 'Cal', 'Dee']]]);

    passes(log, removal);
    expect(log.state().removals.map((r) => [r.member, r.removed])).toEqual([
      [authorOf('cal'), null],
    ]);
    expect(await pickerOf('Ana', log)).toEqual([['Riverside Tenants', ['Ben', 'Dee']]]);

    // A choice made from the list as it stood before is refused before anything is made, kept or sent.
    const store = await deviceOf('Ana', log);
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const sync = createSync({ store, relay, seal: xchachaSeal, clock: () => TS });
    syncs.push(sync);
    const services: RecoveryServices = { store, relay, sync, now: () => TS };
    const contacts = ['ben', 'cal', 'dee'].map((name) => ({
      groupId: log.group,
      member: authorOf(name),
    }));
    await expect(chooseContacts(services, { t: 2, contacts })).rejects.toThrow(
      'That person can’t hold a recovery share.',
    );
    expect(await store.getRecoveryPlan()).toBeUndefined();
    expect(await store.getRelayBackup()).toBeUndefined();
    expect((await store.getGroup(log.group))?.outbox).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it('offers the person it names nobody in that group', async () => {
    const { log, removal } = riverside();
    // The control: while the removal is open, Cal may still choose from Riverside.
    expect(await pickerOf('Cal', log)).toEqual([['Riverside Tenants', ['Ana', 'Ben', 'Dee']]]);

    passes(log, removal);
    expect(await pickerOf('Cal', log)).toEqual([]);
  });
});
