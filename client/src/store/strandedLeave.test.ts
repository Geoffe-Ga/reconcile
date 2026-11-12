/**
 * A leave that races a key change, through the sync loop and the fake relay
 * (#225). Dee leaves and Ana's device writes the key change; meanwhile Cal,
 * who hadn't heard, leaves too, and Cal's leave lands in the old epoch's
 * mailbox after the key change. The fold ignores it there, as any record from
 * another epoch's mailbox (#98), and devices that took up the new key never
 * read the old mailbox again. So it has to reach the new one: Cal's own
 * device posts it there before it lets the group go, and a device that read
 * it before taking the key up posts it there too. Either way every device
 * ends Cal's membership at the same place, folds one state, and the next key
 * change leaves Cal out.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { deriveSealKey, deriveWeekMailboxId, newGroupSecret, weekOf } from '../crypto/groupKeys';
import { open, xchachaSeal } from '../crypto/seal';
import { parseRecord, type SignedEvent } from '../engine/event';
import { fold, type GroupState } from '../engine/fold';
import { createRelay, type Relay } from '../net/relay';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys, testKx } from '../test/keys';
import { type Group, openStore, type Store } from './db';
import { createSync, type Sync } from './sync';

freshIndexedDBPerTest();

const TS = 1_762_650_000_000;
const opened: Sync[] = [];

afterEach(() => {
  for (const sync of opened.splice(0)) sync.stop();
});

/** One member's device: its store and sync loop. */
interface Device {
  readonly name: string;
  readonly store: Store;
  readonly sync: Sync;
  group(): Promise<Group>;
  state(): Promise<GroupState>;
}

/** The fake relay, the group's founding, and a way to post as a member who plays no device. */
interface Scene {
  readonly fake: FakeRelay;
  readonly relay: Relay;
  readonly founding: SignedEvent;
  /** Posts `record`, sealed under `secret`, to this week's mailbox, as a client the test plays would. */
  post(secret: Uint8Array, record: Uint8Array): Promise<void>;
}

/** A device of `name` in `scene`'s group, holding `secret` and its encryption key. */
async function deviceOf(scene: Scene, name: string, secret: Uint8Array): Promise<Device> {
  const store = await openStore(name);
  const { secretKey: signingKey, author } = testKeys(name);
  const groupId = scene.founding.id;
  await store.addGroup({
    groupId,
    secret,
    signingKey,
    kxKey: testKx(name).kxKey,
    me: { author, name },
  });
  const sync = createSync({ store, relay: scene.relay, seal: xchachaSeal, clock: () => TS });
  opened.push(sync);
  const group = async (): Promise<Group> => {
    const found = await store.getGroup(groupId);
    if (found === undefined) throw new Error(`${name}'s group is gone`);
    return found;
  };
  const state = async (): Promise<GroupState> => {
    const { log, relayNow } = await group();
    return fold(log, relayNow);
  };
  return { name, store, sync, group, state };
}

/** `name` joins `founding`'s group at the default level, with their encryption key. */
function joinOf(founding: SignedEvent, name: string): SignedEvent {
  return signedAs(name, {
    type: 'join',
    group: founding.id,
    ts: TS,
    body: { name, kx: testKx(name).kx },
  });
}

/** `name`'s leave of `founding`'s group. */
function leaveOf(founding: SignedEvent, name: string): SignedEvent {
  return signedAs(name, { type: 'leave', group: founding.id, ts: TS, body: {} });
}

/**
 * Ana founds a group and the members in `names` join from devices of their
 * own, then each of `clients`, in order, from a client the test plays;
 * everyone syncs.
 */
async function group(names: readonly string[], clients: readonly string[]) {
  const fake = createFakeRelay();
  const relay = createRelay({ fetch: fake.fetch });
  const founding = signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: TS,
    body: {
      name: 'Riverside Tenants',
      founder: 'Ana',
      documents: [{ title: 'House rules', atoms: ['Quiet after 10pm.'] }],
      kx: testKx('ana').kx,
    },
  });
  const post = async (secret: Uint8Array, record: Uint8Array): Promise<void> => {
    const mailbox = deriveWeekMailboxId(secret, weekOf(fake.minute));
    await relay.putBlob(mailbox, xchachaSeal.seal(mailbox, deriveSealKey(secret), record), 30);
  };
  const scene: Scene = { fake, relay, founding, post };
  const secret = newGroupSecret();
  const devices = new Map<string, Device>();
  for (const name of names) devices.set(name, await deviceOf(scene, name, secret));
  const device = (name: string): Device => {
    const found = devices.get(name);
    if (found === undefined) throw new Error(`no device for ${name}`);
    return found;
  };
  await device('ana').store.enqueue(founding.id, founding.record);
  await device('ana').sync.syncOnce();
  for (const name of names.filter((each) => each !== 'ana')) {
    await device(name).store.enqueue(founding.id, joinOf(founding, name).record);
    await device(name).sync.syncOnce();
  }
  for (const name of clients) await post(secret, joinOf(founding, name).record);
  for (const name of names) await device(name).sync.syncOnce();
  return { scene, secret, device };
}

/** `device`'s member leaves from it, which lets the group go: their leave. */
async function leavesFrom(device: Device, scene: Scene): Promise<SignedEvent> {
  const groupId = scene.founding.id;
  const leave = leaveOf(scene.founding, device.name);
  await device.store.markLeaving(groupId, leave.record);
  await device.sync.syncOnce();
  expect(await device.store.getGroup(groupId)).toBeUndefined();
  return leave;
}

/** Runs one pass on each device in turn, `rounds` times. */
async function passes(devices: readonly Device[], rounds: number): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const device of devices) await device.sync.syncOnce();
  }
}

/** The event type of each blob the relay holds that opens under `secret`, in any week this test sees. */
function typesUnder(scene: Scene, secret: Uint8Array): string[] {
  const mailbox = deriveWeekMailboxId(secret, weekOf(scene.fake.minute));
  const key = deriveSealKey(secret);
  return scene.fake.blobs(mailbox).flatMap((blob) => {
    const bytes = open(mailbox, key, blob);
    return bytes === null ? [] : [parseRecord(bytes)?.event.type ?? '?'];
  });
}

/** The epoch of each mailbox `device` read `event` from, in its log's order. */
async function epochsHolding(device: Device, event: SignedEvent): Promise<number[]> {
  const { log } = await device.group();
  return log
    .filter((record) => parseRecord(record.bytes)?.id === event.id)
    .map((record) => record.epoch ?? 0);
}

/** Each device's epoch, its secret and the state it folds, apart from the records each left out. */
async function together(devices: readonly Device[]) {
  const groups = await Promise.all(devices.map((device) => device.group()));
  const states = await Promise.all(devices.map((device) => device.state()));
  return {
    epochs: groups.map((held) => held.epoch ?? 0),
    secrets: new Set(groups.map((held) => base64url(held.secret))),
    states: states.map((state) => ({ ...state, ignored: [] })),
    state: states[0],
  };
}

/**
 * That `devices` hold one secret at epoch 2 and fold one state, in which Cal
 * and Dee have left and the key change into epoch 2 wraps to no one but the
 * members who stay.
 */
async function expectCalOutEverywhere(devices: readonly Device[]): Promise<GroupState> {
  const after = await together(devices);
  expect(after.epochs).toEqual(devices.map(() => 2));
  expect(after.secrets.size).toBe(1);
  const [first] = after.states;
  expect(after.states).toEqual(after.states.map(() => first));
  const state = after.state;
  if (state === undefined) throw new Error('a state');
  expect(state.former.map((m) => m.author)).toEqual([authorOf('dee'), authorOf('cal')]);
  expect(state.rotations.map((r) => r.epoch)).toEqual([1, 2]);
  const [, next] = state.rotations;
  expect(Object.keys(next?.wraps ?? {}).sort()).toEqual([authorOf('ana'), authorOf('ben')].sort());
  expect(state.stranded).toEqual([]);
  return state;
}

describe('a leave that lands in the old mailbox after a key change (#225)', () => {
  it('reaches the new mailbox from the leaver’s own device, so every device ends the membership and the next key change leaves them out', async () => {
    const { scene, secret, device } = await group(['ana', 'ben', 'cal', 'dee'], []);
    const [ana, ben, cal] = [device('ana'), device('ben'), device('cal')];
    await leavesFrom(device('dee'), scene);
    // Ana writes the key change, and she and Ben take it up before Cal's leave lands.
    await passes([ana, ben], 2);
    expect((await together([ana, ben])).epochs).toEqual([1, 1]);
    const moved = (await ana.group()).secret;

    // Cal hadn't heard: the leave goes to the old mailbox, after the key change.
    const leave = await leavesFrom(cal, scene);

    expect(typesUnder(scene, secret).filter((type) => type === 'leave')).toHaveLength(2);
    expect(typesUnder(scene, moved)).toEqual(['leave']);
    await passes([ana, ben], 2);
    await expectCalOutEverywhere([ana, ben]);
    // Neither remaining device ever read the old copy.
    expect(await epochsHolding(ana, leave)).toEqual([1]);
    expect(await epochsHolding(ben, leave)).toEqual([1]);
  });

  it('reaches it from a device that read it before taking the key up, when the leaver’s device didn’t post it, and that device and one that never read it fold alike', async () => {
    const { scene, secret, device } = await group(['ana', 'ben', 'dee'], ['cal']);
    const [ana, ben] = [device('ana'), device('ben')];
    await leavesFrom(device('dee'), scene);
    // Ana writes and takes up the key change; Ben is away.
    await passes([ana], 2);
    expect((await ana.group()).epoch).toBe(1);
    // Cal's client puts its leave in the old mailbox and lets the group go at once.
    const leave = leaveOf(scene.founding, 'cal');
    await scene.post(secret, leave.record);
    await passes([ana], 1);
    expect((await ana.state()).members.map((m) => m.author)).toContain(authorOf('cal'));

    // Ben comes back, reads Cal's leave before taking the key up, and posts it to the new mailbox.
    await ben.sync.syncOnce();

    expect(typesUnder(scene, (await ana.group()).secret)).toContain('leave');
    await passes([ana, ben], 2);
    await expectCalOutEverywhere([ana, ben]);
    // Ben read the old copy and the new; Ana only the new.
    expect(await epochsHolding(ben, leave)).toEqual([0, 1]);
    expect(await epochsHolding(ana, leave)).toEqual([1]);
  });
});

/** `name`'s 4 on the Proposal `proposal` in `founding`'s group. */
function passOf(founding: SignedEvent, name: string, proposal: SignedEvent): SignedEvent {
  const body = { proposal: proposal.id, scores: { [proposal.id]: 4 as const } };
  return signedAs(name, { type: 'vote', group: founding.id, ts: TS, body });
}

describe('a remove that lands in the old mailbox after a key change (#376)', () => {
  it('reaches the new mailbox from a device that read it before taking the key up, when the remover’s device is gone, so every device takes the member out with it and the next key change leaves them out', async () => {
    // Ana and Ben have devices; Dee, Cal and Eve post from clients the test plays.
    const { scene, secret, device } = await group(['ana', 'ben'], ['dee', 'cal', 'eve']);
    const [ana, ben] = [device('ana'), device('ben')];
    const { founding } = scene;
    // Ana, Ben and Dee, the first three in, hold voting rights. Ana and Ben score removing Cal 4.
    const target = { kind: 'remove' as const, member: authorOf('cal') };
    const body = { target, title: 'Remove Cal', why: 'He keeps breaking the house rules.' };
    const removal = signedAs('ana', { type: 'proposal', group: founding.id, ts: TS, body });
    await scene.post(secret, removal.record);
    for (const name of ['ana', 'ben']) {
      await scene.post(secret, passOf(founding, name, removal).record);
    }
    await passes([ana, ben], 1);
    // Eve leaves: Ana's device writes the key change and takes it up. Ben is away.
    await scene.post(secret, leaveOf(founding, 'eve').record);
    await passes([ana], 1);
    const moved = (await ana.group()).secret;
    expect((await ana.group()).epoch).toBe(1);
    // Dee's device, holding the new key, scores it 4 there, which closes it early with a pass;
    // then Dee's old client, which hadn't heard of the key change, posts the remove to the old
    // mailbox, and Dee's devices are gone. Ana's device hasn't synced since.
    await scene.post(moved, passOf(founding, 'dee', removal).record);
    const remove = signedAs('dee', {
      type: 'remove',
      group: founding.id,
      ts: TS,
      body: { proposal: removal.id },
    });
    await scene.post(secret, remove.record);

    // Ben comes back, reads the remove before taking the key up, and posts it to the new mailbox.
    await ben.sync.syncOnce();
    expect(await epochsHolding(ben, remove)).toEqual([0, 1]);
    await passes([ana, ben], 3);

    const after = await together([ana, ben]);
    expect(after.epochs).toEqual([2, 2]);
    expect(after.secrets.size).toBe(1);
    const [first] = after.states;
    expect(after.states).toEqual(after.states.map(() => first));
    const state = after.state;
    if (state === undefined) throw new Error('a state');
    // Dee's own remove, carried, is the one that takes Cal out, where it landed in the new mailbox.
    expect(state.removals.map((r) => [r.member, r.removed?.id, r.removed?.by])).toEqual([
      [authorOf('cal'), remove.id, authorOf('dee')],
    ]);
    expect(state.former.map((m) => m.author)).toEqual([authorOf('eve'), authorOf('cal')]);
    expect(state.rotations.map((r) => r.epoch)).toEqual([1, 2]);
    const [, next] = state.rotations;
    expect(Object.keys(next?.wraps ?? {}).sort()).toEqual(
      [authorOf('ana'), authorOf('ben'), authorOf('dee')].sort(),
    );
    expect(state.stranded).toEqual([]);
  });
});
