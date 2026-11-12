/**
 * A key change that doesn't open, through the sync loop and the fake relay
 * (#224). A member posts a `key-rotate` that passes every check the fold can
 * make, right after someone leaves, with wraps that don't open. The remaining
 * devices each find that out, say so, refuse it, write a fresh key change and
 * move on together; the member can't do it twice. The key change a removal
 * by vote calls for (#115) is checked and refused the same way. A key change
 * only some wraps of which open is refused the same way, by everyone, and a
 * false word against an honest one changes nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { BOX_OVERHEAD } from '../crypto/box';
import { epochCommit, newEpochSecret, wrapEpochSecret } from '../crypto/epoch';
import { deriveSealKey, deriveWeekMailboxId, newGroupSecret, weekOf } from '../crypto/groupKeys';
import { open, xchachaSeal } from '../crypto/seal';
import { parseRecord, type SignedEvent } from '../engine/event';
import { fold, type GroupState, keyHolders } from '../engine/fold';
import { createRelay, type Relay } from '../net/relay';
import { local } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf, signedAs, testKeys, testKx } from '../test/keys';
import { type Group, openStore, type Store } from './db';
import { keyChangeOf } from './epochs';
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

/** A group on the fake relay: its founding, and a way to post as a member with no device. */
interface Scene {
  readonly fake: FakeRelay;
  readonly relay: Relay;
  readonly founding: SignedEvent;
  /** Posts `record`, sealed under `secret`, to this week's mailbox, as Zed's own client would. */
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

/**
 * Ana founds a group; Ben and Dee join from devices of their own, and Zed and
 * Cal from clients the test plays; everyone syncs.
 */
async function group(): Promise<{ scene: Scene; secret: Uint8Array; honest: Device[] }> {
  const fake = createFakeRelay();
  const relay = createRelay({ fetch: fake.fetch });
  const founding = signedAs('ana', {
    type: 'genesis',
    group: '',
    ts: TS,
    body: {
      name: 'Riverside Tenants',
      founder: 'Ana',
      title: 'House rules',
      atoms: ['Quiet after 10pm.'],
      kx: testKx('ana').kx,
    },
  });
  const post = async (secret: Uint8Array, record: Uint8Array): Promise<void> => {
    const mailbox = deriveWeekMailboxId(secret, weekOf(fake.minute));
    await relay.putBlob(mailbox, xchachaSeal.seal(mailbox, deriveSealKey(secret), record), 30);
  };
  const scene = { fake, relay, founding, post };
  const secret = newGroupSecret();
  const [ana, ben, dee] = await Promise.all(
    ['ana', 'ben', 'dee'].map((name) => deviceOf(scene, name, secret)),
  );
  if (ana === undefined || ben === undefined || dee === undefined) throw new Error('devices');
  await ana.store.enqueue(founding.id, founding.record);
  await ana.sync.syncOnce();
  for (const device of [ben, dee]) {
    await device.store.enqueue(founding.id, joinOf(founding, device.name).record);
    await device.sync.syncOnce();
  }
  await post(secret, joinOf(founding, 'zed').record);
  await post(secret, joinOf(founding, 'cal').record);
  for (const device of [ana, ben, dee]) await device.sync.syncOnce();
  return { scene, secret, honest: [ana, ben, dee] };
}

/** Cal, playing no device, leaves: a key change is due. */
async function calLeaves(scene: Scene, secret: Uint8Array): Promise<void> {
  const leave = signedAs('cal', { type: 'leave', group: scene.founding.id, ts: TS, body: {} });
  await scene.post(secret, leave.record);
}

/**
 * Ana proposes removing Cal, and the three who hold votes, Ana, Ben and Dee,
 * each score it 4, which closes it early with a pass (#115). A minute later
 * its pass is final, and anyone may post the `remove`. Returns the removal.
 */
async function removeCal(scene: Scene, secret: Uint8Array): Promise<SignedEvent> {
  const group = scene.founding.id;
  const removal = signedAs('ana', {
    type: 'proposal',
    group,
    ts: TS,
    body: {
      target: { kind: 'remove', member: authorOf('cal') },
      title: 'Remove Cal',
      why: 'He keeps breaking the house rules.',
    },
  });
  await scene.post(secret, removal.record);
  for (const name of ['ana', 'ben', 'dee']) {
    const scores = { [removal.id]: 4 as const };
    const vote = signedAs(name, {
      type: 'vote',
      group,
      ts: TS,
      body: { proposal: removal.id, scores },
    });
    await scene.post(secret, vote.record);
  }
  scene.fake.minute += 1;
  return removal;
}

/** Bytes no X25519 secret opens as a wrap: a box's length, all sevens. */
const GARBAGE = base64url(new Uint8Array(BOX_OVERHEAD + 32).fill(7));

/**
 * Zed's key change into `epoch`, for the members of `state`: a commit to a
 * fresh secret, and a wrap for each current key holder, made by the rule for
 * those not in `poisoned` and garbage for those who are.
 */
function zedRotate(state: GroupState, epoch: number, poisoned: readonly string[]): SignedEvent {
  const groupId = state.group ?? '';
  const secret = newEpochSecret();
  const commit = epochCommit(groupId, epoch, secret);
  const wraps = Object.fromEntries(
    keyHolders(state).map(({ author, kx }) => {
      if (poisoned.includes(author)) return [author, GARBAGE];
      const place = { groupId, epoch, member: author, commit };
      return [author, wrapEpochSecret({ ...place, kx: fromBase64url(kx), secret })];
    }),
  );
  return signedAs('zed', {
    type: 'key-rotate',
    group: groupId,
    ts: TS,
    body: { epoch, commit, wraps },
  });
}

/** Every member's author but Cal's, who left: the recipients of a key change after Cal's leave. */
const EVERYONE = ['ana', 'ben', 'dee', 'zed'].map(authorOf);

/** The fold of `honest`'s log with Cal's leave added: what Zed's client would see. */
async function afterLeave(device: Device, scene: Scene): Promise<GroupState> {
  const { log } = await device.group();
  const leave = signedAs('cal', { type: 'leave', group: scene.founding.id, ts: TS, body: {} });
  const next = {
    seq: (log.at(-1)?.seq ?? 0) + 1,
    received: scene.fake.minute,
    bytes: leave.record,
  };
  return fold([...log, next], null);
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

/** Runs one pass on each device in turn, `rounds` times. */
async function passes(devices: readonly Device[], rounds: number): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const device of devices) await device.sync.syncOnce();
  }
}

/** A state two devices fold, apart from the records each left out. */
function comparable(state: GroupState): GroupState {
  return { ...state, ignored: [] };
}

/** Each device's epoch, its secret, and the state each folds, apart from the records each left out. */
async function together(devices: readonly Device[]) {
  const groups = await Promise.all(devices.map((device) => device.group()));
  const states = await Promise.all(devices.map((device) => device.state()));
  return {
    epochs: groups.map((held) => held.epoch ?? 0),
    secrets: new Set(groups.map((held) => base64url(held.secret))),
    states: states.map(comparable),
    state: states[0],
    secret: groups[0]?.secret ?? new Uint8Array(),
  };
}

/** That `after`'s devices hold one secret and fold one state. */
function expectOne(after: Awaited<ReturnType<typeof together>>): void {
  expect(after.secrets.size).toBe(1);
  const [first] = after.states;
  expect(after.states).toEqual(after.states.map(() => first));
}

/** `devices` as three, Ana's, Ben's and Dee's. */
function trio(devices: readonly Device[]): [Device, Device, Device] {
  const [ana, ben, dee] = devices;
  if (ana === undefined || ben === undefined || dee === undefined) throw new Error('three devices');
  return [ana, ben, dee];
}

/** After one pass, Ana's device holds `poison` canonical, hasn't moved, says it missed the key, and has queued its word. */
async function expectSaidOnce(ana: Device, poison: SignedEvent): Promise<void> {
  const state = await ana.state();
  const held = await ana.group();
  expect(state.rotations.map((r) => r.id)).toEqual([poison.id]);
  expect([held.epoch ?? 0, keyChangeOf(held, state)]).toEqual([0, 'missed']);
  expect(held.outbox.map((bytes) => parseRecord(bytes)?.event)).toEqual([
    expect.objectContaining({ type: 'unwrap-failed', body: { rotation: poison.id } }),
  ]);
}

/** Every device is on epoch 2, with one secret and state: `poison` refused, `again` ignored, one fresh key change. */
async function expectRecovered(
  honest: readonly Device[],
  scene: Scene,
  zed: { readonly poison: SignedEvent; readonly again: SignedEvent; readonly old: Uint8Array },
): Promise<Uint8Array> {
  const after = await together(honest);
  expect(after.epochs).toEqual([2, 2, 2]);
  expectOne(after);
  const { state, secret } = after;
  expect(state?.refused.map((r) => [r.id, r.by])).toEqual([[zed.poison.id, authorOf('zed')]]);
  expect(state?.rotations.map((r) => r.epoch)).toEqual([2]);
  expect(state?.ignored.map((r) => r.id)).toContain(zed.again.id);
  expect(epochCommit(scene.founding.id, 2, secret)).toBe(state?.rotations[0]?.commit);
  expect(local(secret)).not.toEqual(local(zed.old));
  // Recipients said so in the old mailbox, where Zed's two and one fresh key change went.
  const old = typesUnder(scene, zed.old);
  expect(old.filter((type) => type === 'key-rotate')).toHaveLength(3);
  expect(old.filter((type) => type === 'unwrap-failed').length).toBeGreaterThanOrEqual(1);
  return secret;
}

/** Ana proposes under the new key, and Ben and Dee fold it after the Proposals `before` names. */
async function expectReadsNext(
  scene: Scene,
  honest: readonly Device[],
  secret: Uint8Array,
  before: readonly string[] = [],
) {
  const [ana, ben, dee] = trio(honest);
  const groupId = scene.founding.id;
  const body = { atom: `${groupId}.0`, title: 'Later', why: 'Shift work.', text: 'Quiet at 11.' };
  const proposal = signedAs('ana', { type: 'proposal', group: groupId, ts: TS, body });
  await ana.store.enqueue(groupId, proposal.record);
  await passes(honest, 1);
  for (const device of [ben, dee]) {
    const ids = (await device.state()).proposals.map((p) => p.id);
    expect(ids, device.name).toEqual([...before, proposal.id]);
  }
  expect(typesUnder(scene, secret)).toContain('proposal');
}

/** Dee leaves; Zed at once writes a key change that doesn't open; it's ignored, and Ana and Ben move on with no word against it. */
async function expectIgnoredNextTime(scene: Scene, honest: readonly Device[], secret: Uint8Array) {
  const [ana, ben, dee] = trio(honest);
  const leave = signedAs('dee', { type: 'leave', group: scene.founding.id, ts: TS, body: {} });
  await dee.store.markLeaving(scene.founding.id, leave.record);
  await dee.sync.syncOnce();
  const now = await ana.state();
  const members = now.members.filter((m) => m.author !== authorOf('dee'));
  const third = zedRotate({ ...now, members }, 3, ['ana', 'ben', 'zed'].map(authorOf));
  await scene.post(secret, third.record);
  await passes([ana, ben], 3);
  const last = await together([ana, ben]);
  expect(last.epochs).toEqual([3, 3]);
  expectOne(last);
  const byZed = last.state?.rotations.map((r) => [r.epoch, r.by === authorOf('zed')]);
  expect(byZed).toEqual([
    [2, false],
    [3, false],
  ]);
  expect(last.state?.ignored.map((r) => r.id)).toContain(third.id);
  expect(typesUnder(scene, secret)).not.toContain('unwrap-failed');
}

describe('a key change whose wraps don’t open (#224)', () => {
  it('is refused by every remaining device, which recover on a fresh key and read what comes next; its author can’t do it again', async () => {
    const { scene, secret, honest } = await group();
    const [ana] = trio(honest);
    const before = await afterLeave(ana, scene);
    await calLeaves(scene, secret);
    // Zed is quick: a key change into epoch 1 none of whose wraps opens, then a second into epoch 2.
    const poison = zedRotate(before, 1, EVERYONE);
    await scene.post(secret, poison.record);
    const again = zedRotate(before, 2, EVERYONE);
    await scene.post(secret, again.record);

    // Each device's first pass finds it can't take the key up, says so, and moves nowhere.
    await ana.sync.syncOnce();
    await expectSaidOnce(ana, poison);

    // The next passes post it, refuse the key change, and write a fresh one that everyone takes up.
    await passes(honest, 3);
    const fresh = await expectRecovered(honest, scene, { poison, again, old: secret });
    await expectReadsNext(scene, honest, fresh);
    await expectIgnoredNextTime(scene, honest, fresh);
  });

  it('is refused when only one member’s wrap doesn’t open: those whose wraps open don’t move on without them', async () => {
    const { scene, secret, honest } = await group();
    const [ana] = trio(honest);
    const before = await afterLeave(ana, scene);
    await calLeaves(scene, secret);
    const poison = zedRotate(before, 1, [authorOf('ben')]);
    await scene.post(secret, poison.record);

    await ana.sync.syncOnce();
    // Ana's own wrap opens, but Ben's isn't the secret's: Ana stays, and says so.
    expect((await ana.group()).epoch ?? 0).toBe(0);
    expect((await ana.group()).outbox.map((bytes) => parseRecord(bytes)?.event.type)).toEqual([
      'unwrap-failed',
    ]);

    await passes(honest, 3);
    const after = await together(honest);
    expect(after.epochs).toEqual([2, 2, 2]);
    expectOne(after);
    expect(after.state?.refused.map((r) => r.id)).toEqual([poison.id]);
  });

  it('after a removal by vote (#115), is refused the same way, and the fresh key change leaves out only the person removed', async () => {
    const { scene, secret, honest } = await group();
    const [ana] = trio(honest);
    const removal = await removeCal(scene, secret);
    // Zed is quick: the remove, then at once two key changes past Cal, none of whose wraps opens.
    const now = await ana.state();
    const members = now.members.filter((m) => m.author !== authorOf('cal'));
    const remove = signedAs('zed', {
      type: 'remove',
      group: scene.founding.id,
      ts: TS,
      body: { proposal: removal.id },
    });
    await scene.post(secret, remove.record);
    const poison = zedRotate({ ...now, members }, 1, EVERYONE);
    await scene.post(secret, poison.record);
    const again = zedRotate({ ...now, members }, 2, EVERYONE);
    await scene.post(secret, again.record);

    // Ana's first pass folds the remove, finds the key change past Cal doesn't open, and says so.
    await ana.sync.syncOnce();
    const removed = await ana.state();
    expect(removed.removals.map((r) => [r.member, r.removed?.id])).toEqual([
      [authorOf('cal'), remove.id],
    ]);
    await expectSaidOnce(ana, poison);

    await passes(honest, 3);
    const fresh = await expectRecovered(honest, scene, { poison, again, old: secret });
    const state = await ana.state();
    expect(state.former.map((m) => m.author)).toEqual([authorOf('cal')]);
    expect(Object.keys(state.rotations[0]?.wraps ?? {}).sort()).toEqual([...EVERYONE].sort());
    await expectReadsNext(scene, honest, fresh, [removal.id]);
  });

  it('stays canonical when a member falsely says their wrap doesn’t open: a device that checks it takes it up and says so', async () => {
    const { scene, secret, honest } = await group();
    const [ana, ben, dee] = trio(honest);
    await calLeaves(scene, secret);
    // Ana and Ben write and take up an honest key change; Dee is away.
    await passes([ana, ben], 3);
    const moved = await together([ana, ben]);
    expect(moved.epochs).toEqual([1, 1]);
    const rotation = moved.state?.rotations[0]?.id ?? '';
    // Zed, whose wrap opens, says it doesn't, in the old mailbox.
    const lie = signedAs('zed', {
      type: 'unwrap-failed',
      group: scene.founding.id,
      ts: TS,
      body: { rotation },
    });
    await scene.post(secret, lie.record);

    // Dee comes back, finds the key change checks out, takes it up and posts a key-taken.
    await dee.sync.syncOnce();
    await passes(honest, 1);
    const after = await together(honest);
    expect(after.epochs).toEqual([1, 1, 1]);
    expectOne(after);
    expect(after.state?.refused).toEqual([]);
    expect(after.state?.rotations.map((r) => r.id)).toEqual([rotation]);
    expect(typesUnder(scene, after.secret)).toContain('key-taken');
    // No second key change was written, and Ana, who wrote the first, may still write the next.
    expect(typesUnder(scene, secret).filter((type) => type === 'key-rotate')).toHaveLength(1);
  });
});
