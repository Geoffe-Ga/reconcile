/**
 * The backup file's contents (#78): what a backup holds of each group and of
 * each personal Document (#93), what it leaves out, and how a restore
 * validates everything before it writes anything, in one transaction.
 */
import { describe, expect, it } from 'vitest';

import { BackupUnreadable, sealBackup } from '../crypto/backup';
import { base64url, fromBase64url } from '../crypto/base64url';
import { newSigningKeys } from '../crypto/sign';
import { fold } from '../engine/fold';
import { local, text, utf8 } from '../test/bytes';
import { testGroup } from '../test/groups';
import { freshIndexedDBPerTest } from '../test/idb';
import { testKeys } from '../test/keys';
import { findCanaries, keyCanaries, textCanary } from '../test/scan';
import { groupLog } from '../test/votes';
import { clearedArchive } from './archive';
import { type BackedUpGroup, type Group, openStore, type Store } from './db';
import { eventIdOf } from './eventId';
import type { PersonalDocument, ShareState } from './personal';
import {
  backedUpGroups,
  decodeSnapshot,
  deviceSnapshot,
  encodeSnapshot,
  exportGroups,
  importGroups,
  MAX_BACKUP_BYTES,
  SNAPSHOT_FORMAT,
  withoutShares,
} from './snapshot';

freshIndexedDBPerTest();

/** A cheap scrypt cost, N = 2^4, for every test but the one through the app (`backupFlow`). */
const CHEAP = 4;
const PASSPHRASE = 'a long walk to the river';

const CANARY = {
  group: 'Canary Street Commons',
  founder: 'Canaryana Founder',
  joiner: 'Canarybenedict Joiner',
  atom: 'Canary atom: the garden opens at dawn.',
  title: 'Canary title: open the garden',
  personalTitle: 'Canary personal title: what I stand for',
  personalText: 'Canary personal text: I show up for my neighbors.',
};

/** The canary personal Document (#93), edited at `updatedAt`. */
function canaryStatement(updatedAt = 1_762_000_500_000): PersonalDocument {
  return {
    id: 'Q2FuYXJ5IHN0YXRlbWVudA',
    title: CANARY.personalTitle,
    text: `# ${CANARY.personalText}\n`,
    createdAt: 1_762_000_400_000,
    updatedAt,
  };
}

/** A second personal Document, beside the canary. */
const READING: PersonalDocument = {
  id: 'UmVhZGluZyBsaXN0IGlkIQ',
  title: 'Reading list',
  text: '- Braiding Sweetgrass\n',
  createdAt: 1_762_000_450_000,
  updatedAt: 1_762_000_460_000,
};

/** The canary group, folded through the engine, as the founder's device would hold it. */
function canaryGroup() {
  const made = testGroup({
    name: CANARY.group,
    founder: CANARY.founder,
    joiners: [CANARY.joiner],
    atoms: [CANARY.atom, 'Bins go out on Tuesday.'],
    proposals: [CANARY.title],
  });
  const groupId = made.state.group;
  if (groupId === null) throw new Error('Expected a group.');
  const { secretKey, author } = testKeys(CANARY.founder.toLowerCase());
  const secret = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
  return { ...made, groupId, secret, secretKey, author };
}

/** Keeps the canary group on `store`, synced at `lastSyncAt`, with an unsent event and a draft. */
async function keepCanary(store: Store, lastSyncAt = 1_762_000_000_000) {
  const group = canaryGroup();
  await store.addGroup({
    groupId: group.groupId,
    secret: group.secret,
    signingKey: group.secretKey,
    me: { author: group.author, name: CANARY.founder },
  });
  const last = group.records.at(-1);
  const pull = {
    records: [...group.records],
    cursor: last?.seq ?? 0,
    relayNow: (last?.received ?? 0) + 5,
    instance: 'relay-1',
    lastSyncAt,
  };
  await store.applyPull(group.groupId, pull, eventIdOf);
  await store.enqueue(group.groupId, utf8('{"unsent":"Canary outbox: never send me"}'));
  await store.writeDraft(group.groupId, 'atom', {
    title: 'Canary draft title',
    why: 'Canary draft why',
    text: 'Canary draft text',
    link: '',
  });
  return group;
}

/** Everything a device's store holds, with bytes as plain arrays, so two dumps compare. */
async function dump(store: Store): Promise<unknown> {
  const groups = await store.listGroups();
  return groups.map((group) => ({
    ...group,
    secret: Array.from(group.secret),
    signingKey: Array.from(group.signingKey),
    log: group.log.map((record) => ({ ...record, bytes: Array.from(record.bytes) })),
    outbox: group.outbox.map((bytes) => Array.from(bytes)),
    drafts: group.drafts === undefined ? undefined : [...group.drafts],
    leaving: group.leaving === undefined ? undefined : Array.from(group.leaving),
  }));
}

/** A second device holding an unrelated group, so a failed restore has something to leave alone. */
async function otherDevice(name = 'other'): Promise<Store> {
  const store = await openStore(name);
  await store.addGroup({
    groupId: 'unrelated-group',
    secret: new Uint8Array(32).fill(1),
    signingKey: new Uint8Array(32).fill(2),
    me: { author: 'author-zed', name: 'Zed' },
  });
  return store;
}

/** What a group's state on `store` folds to. */
async function folded(store: Store, groupId: string) {
  const group = await store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group.');
  return fold(group.log, group.relayNow);
}

describe('exportGroups and importGroups', () => {
  it('bring every group back on another device with the same keys, log and sync state', async () => {
    const device = await openStore('ana');
    const group = await keepCanary(device);

    const { file, groupIds } = await exportGroups(device, PASSPHRASE, CHEAP);
    const second = await openStore('ana-again');
    const restored = await importGroups(second, file, PASSPHRASE);

    expect(restored).toBe(1);
    expect(groupIds).toEqual([group.groupId]);
    const [held] = await second.listGroups();
    expect(held?.me).toEqual({ author: group.author, name: CANARY.founder });
    expect(local(held?.signingKey ?? new Uint8Array())).toEqual(local(group.secretKey));
    expect(local(held?.secret ?? new Uint8Array())).toEqual(local(group.secret));
    expect(held?.log.map((record) => [record.seq, record.received, text(record.bytes)])).toEqual(
      group.records.map((record) => [record.seq, record.received, text(record.bytes)]),
    );
    const original = await device.getGroup(group.groupId);
    expect({ ...held, log: [], secret: [], signingKey: [] }).toEqual({
      groupId: group.groupId,
      me: original?.me,
      log: [],
      secret: [],
      signingKey: [],
      cursor: original?.cursor,
      relayNow: original?.relayNow,
      instance: 'relay-1',
      lastSyncAt: 1_762_000_000_000,
      missingHistory: false,
      outbox: [],
      backup: 'saved',
    });
    expect(await folded(second, group.groupId)).toEqual(await folded(device, group.groupId));
  });

  it('leave out the outbox, drafts and chat claims, so a restore never sends stale intent', async () => {
    const device = await openStore('ana');
    const kept = await keepCanary(device);
    const claim = {
      id: 'Canary claim id',
      proposal: 'Canary claim proposal',
      moment: 'open',
    } as const;
    await device.claimChat(kept.groupId, utf8('{"claim":"Canary claim record"}'), claim);
    const [group] = await device.listGroups();
    if (group === undefined) throw new Error('Expected the group.');

    const plaintext = encodeSnapshot({ groups: backedUpGroups([group]), personal: [] });

    expect(text(plaintext)).not.toContain('Canary outbox');
    expect(text(plaintext)).not.toContain('Canary draft');
    expect(text(plaintext)).not.toContain('Canary claim');
    expect(Object.keys(JSON.parse(text(plaintext)) as object)).toEqual([
      'format',
      'groups',
      'personal',
    ]);
    expect(SNAPSHOT_FORMAT).toBe(1);
  });

  it('leave out a group this device is leaving, and one whose genesis the relay hasn’t returned', async () => {
    const device = await openStore('ana');
    const kept = await keepCanary(device);
    await device.addGroup({
      groupId: 'not-back-yet',
      secret: new Uint8Array(32),
      signingKey: new Uint8Array(32),
      me: { author: 'author-ana', name: 'Ana' },
    });
    const leaving = testGroup({ name: 'Leaving group' });
    const leavingId = leaving.state.group ?? '';
    await device.addGroup({
      groupId: leavingId,
      secret: new Uint8Array(32).fill(3),
      signingKey: testKeys('ana').secretKey,
      me: { author: leaving.founder, name: 'Ana' },
    });
    const pull = {
      records: [...leaving.records],
      cursor: 9,
      relayNow: 1,
      instance: 'r',
      lastSyncAt: 1,
    };
    await device.applyPull(leavingId, pull, eventIdOf);
    await device.markLeaving(leavingId, utf8('{"leave":1}'));

    const { file, groupIds } = await exportGroups(device, PASSPHRASE, CHEAP);
    const second = await openStore('second');

    expect(groupIds).toEqual([kept.groupId]);
    expect(await importGroups(second, file, PASSPHRASE)).toBe(1);
    expect((await second.listGroups()).map((group) => group.groupId)).toEqual([kept.groupId]);
  });

  it('say how many groups a backup of none brought back', async () => {
    const empty = await openStore('empty');

    const { file, groupIds } = await exportGroups(empty, PASSPHRASE, CHEAP);

    expect(groupIds).toEqual([]);
    expect(await importGroups(await openStore('second'), file, PASSPHRASE)).toBe(0);
  });
});

describe('personal Documents in a backup (#93)', () => {
  it('bring back a group and two personal Documents, all three, on a fresh device', async () => {
    const device = await openStore('ana');
    const group = await keepCanary(device);
    await device.savePersonal(canaryStatement());
    await device.savePersonal(READING);

    const { file, groupIds } = await exportGroups(device, PASSPHRASE, CHEAP);
    const fresh = await openStore('fresh');
    const restored = await importGroups(fresh, file, PASSPHRASE);

    expect([restored, groupIds]).toEqual([1, [group.groupId]]);
    expect((await fresh.listGroups()).map((held) => held.groupId)).toEqual([group.groupId]);
    expect(await fresh.listPersonal()).toEqual([canaryStatement(), READING]);
  });

  it('keep the device’s copy of a Document edited there after the backup', async () => {
    const device = await openStore('ana');
    await keepCanary(device);
    await device.savePersonal(canaryStatement(1_762_000_500_000));
    const { file } = await exportGroups(device, PASSPHRASE, CHEAP);
    const later = { ...canaryStatement(1_762_000_900_000), text: 'Edited after the backup.' };
    await device.savePersonal(later);

    await importGroups(device, file, PASSPHRASE);

    expect(await device.listPersonal()).toEqual([later]);
  });

  it('bring back the file’s copy over an older one on the device', async () => {
    const device = await openStore('ana');
    await device.savePersonal(canaryStatement(1_762_000_500_000));
    const { file } = await exportGroups(device, PASSPHRASE, CHEAP);
    const second = await openStore('second');
    await second.savePersonal({ ...canaryStatement(1_762_000_450_000), text: 'Older.' });

    expect(await importGroups(second, file, PASSPHRASE)).toBe(0);

    expect(await second.listPersonal()).toEqual([canaryStatement(1_762_000_500_000)]);
  });

  it('restore an older backup, with no personal field, as its groups and no Documents', async () => {
    const device = await openStore('ana');
    const group = await keepCanary(device);
    const snapshot = JSON.parse(text(await snapshotOf(device))) as Record<string, unknown>;
    const older = { format: snapshot.format, groups: snapshot.groups };
    const file = await sealBackup(utf8(JSON.stringify(older)), PASSPHRASE, CHEAP);
    const second = await openStore('second');
    await second.savePersonal(READING);

    expect(Object.keys(older)).toEqual(['format', 'groups']);
    expect(await importGroups(second, file, PASSPHRASE)).toBe(1);
    expect((await second.listGroups()).map((held) => held.groupId)).toEqual([group.groupId]);
    expect(await second.listPersonal()).toEqual([READING]);
  });

  it('carry each Document as the device keeps it, and nothing else of it', async () => {
    const device = await openStore('ana');
    await device.savePersonal(canaryStatement());

    const json = JSON.parse(text(await snapshotOf(device))) as { personal: unknown };

    expect(json.personal).toEqual([canaryStatement()]);
  });
});

/** The canary statement's share by link (#105): its own seed and keys, posted twice. */
const SHARE_KEYS = newSigningKeys();
const SHARE: ShareState = {
  seed: Uint8Array.from({ length: 32 }, (_, i) => 90 + i),
  secretKey: SHARE_KEYS.secretKey,
  publicKey: SHARE_KEYS.publicKey,
  n: 2,
  lastPostedAt: 1_762_000_600_000,
  pending: true,
};

/** Keeps the canary statement on `store`, shared by link. */
async function keepShared(store: Store): Promise<void> {
  await store.savePersonal(canaryStatement());
  await store.updateShare(canaryStatement().id, () => SHARE);
}

/** `value` with every byte array spelled as a plain list, so arrays IndexedDB cloned compare equal. */
function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      Object.prototype.toString.call(item) === '[object Uint8Array]'
        ? Array.from(item as Uint8Array)
        : item,
    ),
  ) as unknown;
}

describe('a shared Document in a backup (#105)', () => {
  it('brings its share back whole, so the restored device keeps the same link and counts on', async () => {
    const device = await openStore('ana');
    await keepShared(device);
    await device.savePersonal(READING);
    const { file } = await exportGroups(device, PASSPHRASE, CHEAP);
    const fresh = await openStore('fresh');

    await importGroups(fresh, file, PASSPHRASE);

    expect(plain(await fresh.listPersonal())).toEqual(
      plain([{ ...canaryStatement(), share: SHARE }, READING]),
    );
  });

  it('keeps the device’s live share when the file’s later copy of that Document holds none, marked pending', async () => {
    const other = await openStore('other-device');
    await other.savePersonal({ ...canaryStatement(1_762_000_900_000), text: 'Edited elsewhere.' });
    const { file } = await exportGroups(other, PASSPHRASE, CHEAP);
    const device = await openStore('ana');
    await keepShared(device);

    await importGroups(device, file, PASSPHRASE);

    expect(plain(await device.listPersonal())).toEqual(
      plain([
        {
          ...canaryStatement(1_762_000_900_000),
          text: 'Edited elsewhere.',
          share: { ...SHARE, pending: true },
        },
      ]),
    );
  });

  it('spells the share’s bytes in base64url, and carries nothing else of it', async () => {
    const device = await openStore('ana');
    await keepShared(device);

    const json = JSON.parse(text(await snapshotOf(device))) as {
      personal: Record<string, unknown>[];
    };

    expect(json.personal).toEqual([
      {
        ...canaryStatement(),
        share: {
          seed: base64url(SHARE.seed),
          secretKey: base64url(SHARE.secretKey),
          publicKey: base64url(SHARE.publicKey),
          n: 2,
          lastPostedAt: 1_762_000_600_000,
          pending: true,
        },
      },
    ]);
  });

  it('reads a share never posted yet, with no post time', async () => {
    const device = await openStore('ana');
    await device.savePersonal(canaryStatement());
    await device.updateShare(canaryStatement().id, () => ({
      ...SHARE,
      n: 0,
      lastPostedAt: null,
    }));

    const snapshot = decodeSnapshot(await snapshotOf(device));

    expect(snapshot?.personal[0]?.share?.lastPostedAt).toBe(null);
    expect(snapshot?.personal[0]?.share?.n).toBe(0);
  });

  const shareBreakings: readonly (readonly [
    string,
    (share: Record<string, unknown>) => unknown,
  ])[] = [
    ['a share that isn’t an object', () => 'shared'],
    ['a seed of 31 bytes', (share) => ({ ...share, seed: base64url(new Uint8Array(31)) })],
    ['a seed in standard base64', (share) => ({ ...share, seed: `${String(share.seed)}=` })],
    [
      'a public key that isn’t its secret key’s',
      (share) => ({ ...share, publicKey: base64url(newSigningKeys().publicKey) }),
    ],
    ['a secret key that isn’t text', (share) => ({ ...share, secretKey: 7 })],
    ['a negative n', (share) => ({ ...share, n: -1 })],
    ['a fractional post time', (share) => ({ ...share, lastPostedAt: 1.5 })],
    ['a pending that isn’t true or false', (share) => ({ ...share, pending: 'yes' })],
  ];

  it.each(shareBreakings)('refuses %s, and writes nothing', async (_name, breaking) => {
    const device = await openStore('ana');
    await keepShared(device);
    const json = JSON.parse(text(await snapshotOf(device))) as {
      personal: Record<string, unknown>[];
    };
    const personal = json.personal.map((document) => ({
      ...document,
      share: breaking(document.share as Record<string, unknown>),
    }));
    const file = await sealBackup(utf8(JSON.stringify({ ...json, personal })), PASSPHRASE, CHEAP);
    const second = await otherDevice('second');

    await expect(importGroups(second, file, PASSPHRASE)).rejects.toThrow(new BackupUnreadable());

    expect(await second.listPersonal()).toEqual([]);
  });

  it('holds no share seed or key in the sealed file, though its plaintext holds each', async () => {
    const device = await openStore('ana');
    await keepShared(device);
    const canaries = [
      ...keyCanaries('share seed', SHARE.seed),
      ...keyCanaries('share secret key', SHARE.secretKey),
    ];

    const { file } = await exportGroups(device, PASSPHRASE, CHEAP);

    expect(findCanaries(await snapshotOf(device), canaries)).not.toEqual([]);
    expect(findCanaries(file, canaries)).toEqual([]);
  });
});

describe('withoutShares (#105, for #96’s second-device link)', () => {
  it('drops every Document’s share and keeps everything else', async () => {
    const device = await openStore('ana');
    const group = await keepCanary(device);
    await keepShared(device);
    await device.savePersonal(READING);
    const snapshot = await deviceSnapshot(device);

    const linked = withoutShares(snapshot);

    expect(linked.groups.map((kept) => kept.groupId)).toEqual([group.groupId]);
    expect(linked.groups).toBe(snapshot.groups);
    expect(linked.personal).toEqual([canaryStatement(), READING]);
    expect(snapshot.personal[0]?.share).toBeDefined();
  });
});

/**
 * A group whose dissolve passed with three 4s and folded a minute later
 * (#108), as Ana's device held it before it marked the group read-only: what
 * an older app's backup file could hold. `live` is the copy from before the
 * dissolve folded, synced a day later by a device that never fetched it.
 */
function dissolvedGroup() {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const motion = log.proposeDissolve('ana', false);
  for (const name of ['ana', 'ben', 'cal']) log.vote(name, motion, 4);
  log.minute += 1;
  log.dissolve('ana', motion);
  const { secretKey, author } = testKeys('ana');
  const records = [...log.records];
  const dissolved: BackedUpGroup = {
    groupId: log.group,
    secret: new Uint8Array(32).fill(5),
    signingKey: secretKey,
    me: { author, name: 'Ana' },
    log: records,
    cursor: records.length,
    relayNow: log.minute + 5,
    instance: 'relay-1',
    lastSyncAt: 1_762_000_000_000,
    missingHistory: false,
  };
  const live: BackedUpGroup = {
    ...dissolved,
    log: records.slice(0, -1),
    cursor: records.length - 1,
    lastSyncAt: 1_762_086_400_000,
  };
  return { groupId: log.group, dissolved, live };
}

/** A file sealing `groups` and `personal` under the test passphrase. */
function fileOf(groups: readonly BackedUpGroup[], personal: readonly PersonalDocument[]) {
  return sealBackup(encodeSnapshot({ groups, personal }), PASSPHRASE, CHEAP);
}

describe('a dissolved group and personal Documents in one backup (#108, #93)', () => {
  it('bring back both from one file: the group as a read-only copy, and every Document', async () => {
    const { groupId, dissolved } = dissolvedGroup();
    const file = await fileOf([dissolved], [canaryStatement(), READING]);
    const fresh = await openStore('fresh');

    expect(await importGroups(fresh, file, PASSPHRASE)).toBe(1);

    const held = await fresh.getGroup(groupId);
    expect(held?.archived).toEqual({ reason: 'dissolved' });
    expect([held?.outbox, held?.backup]).toEqual([[], 'saved']);
    expect(held?.log.map((record) => text(record.bytes))).toEqual(
      dissolved.log.map((record) => text(record.bytes)),
    );
    expect(await folded(fresh, groupId)).toMatchObject({ dissolved: { wipe: false } });
    await expect(fresh.enqueue(groupId, utf8('{"late":1}'))).rejects.toThrow('read-only');
    expect(await fresh.listPersonal()).toEqual([canaryStatement(), READING]);
  });

  it('leave the read-only copy out of the next backup, which still carries every Document', async () => {
    const { groupId, dissolved } = dissolvedGroup();
    const device = await openStore('ana');
    await importGroups(device, await fileOf([dissolved], [canaryStatement()]), PASSPHRASE);
    await device.savePersonal(READING);

    const plaintext = await snapshotOf(device);
    const { file, groupIds } = await exportGroups(device, PASSPHRASE, CHEAP);
    const second = await openStore('second');

    expect(groupIds).toEqual([]);
    expect(text(plaintext)).not.toContain(groupId);
    expect(await importGroups(second, file, PASSPHRASE)).toBe(0);
    expect(await second.listGroups()).toEqual([]);
    expect(await second.listPersonal()).toEqual([canaryStatement(), READING]);
  });

  it('keep a cleared archive as it is against a file’s later live copy, and still merge the file’s Documents', async () => {
    const { groupId, dissolved, live } = dissolvedGroup();
    const device = await openStore('ana');
    await importGroups(device, await fileOf([dissolved], []), PASSPHRASE);
    const state = await folded(device, groupId);
    await device.clearArchive(groupId, clearedArchive(state, 1_764_000_000_000));
    await device.savePersonal({ ...canaryStatement(1_762_000_450_000), text: 'Older.' });
    const before = await dump(device);

    const file = await fileOf([live], [canaryStatement(1_762_000_500_000), READING]);
    expect(await importGroups(device, file, PASSPHRASE)).toBe(1);

    expect(await dump(device)).toEqual(before);
    const kept = await device.getGroup(groupId);
    expect(kept?.log).toEqual([]);
    expect(kept?.archived?.cleared?.state.dissolved).toEqual(state.dissolved);
    expect(await device.listPersonal()).toEqual([canaryStatement(1_762_000_500_000), READING]);
  });
});

/** The backup plaintext of everything on `store`, as `exportGroups` seals it. */
async function snapshotOf(store: Store): Promise<Uint8Array> {
  return encodeSnapshot(await deviceSnapshot(store));
}

describe('a backup that doesn’t open', () => {
  it('fails with the plain error for a wrong passphrase, and changes nothing', async () => {
    const device = await openStore('ana');
    await keepCanary(device);
    const { file } = await exportGroups(device, PASSPHRASE, CHEAP);
    const second = await otherDevice();
    const before = await dump(second);

    await expect(importGroups(second, file, 'a long walk to the rivers')).rejects.toThrow(
      BackupUnreadable,
    );

    expect(await dump(second)).toEqual(before);
  });

  it('fails alike for a file with any single byte changed, in the header or the body', async () => {
    const device = await openStore('ana');
    await keepCanary(device);
    const { file } = await exportGroups(device, PASSPHRASE, CHEAP);
    const second = await otherDevice();
    const before = await dump(second);
    // Every byte of the header, then every 97th byte of the body, and the last.
    const at = [
      ...Array.from({ length: 47 }, (_, i) => i),
      ...Array.from({ length: Math.ceil((file.length - 47) / 97) }, (_, i) => 47 + i * 97),
      file.length - 1,
    ];

    for (const index of at) {
      const changed = Uint8Array.from(file);
      changed[index] = (changed[index] ?? 0) ^ 0x01;
      await expect(importGroups(second, changed, PASSPHRASE)).rejects.toThrow(
        new BackupUnreadable(),
      );
    }

    expect(await dump(second)).toEqual(before);
  });

  it('refuses a file over 64 MiB before opening it', async () => {
    const second = await otherDevice();

    await expect(
      importGroups(second, new Uint8Array(MAX_BACKUP_BYTES + 1), PASSPHRASE),
    ).rejects.toThrow(BackupUnreadable);
    expect(MAX_BACKUP_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('a backup that opens but doesn’t hold valid groups', () => {
  /** The canary group's snapshot as plain JSON, for a test to break. */
  async function validSnapshot(): Promise<{
    format: number;
    groups: Record<string, unknown>[];
    personal: Record<string, unknown>[];
  }> {
    const device = await openStore('ana');
    await keepCanary(device);
    await device.savePersonal(canaryStatement());
    await device.savePersonal(READING);
    return JSON.parse(text(await snapshotOf(device))) as {
      format: number;
      groups: Record<string, unknown>[];
      personal: Record<string, unknown>[];
    };
  }

  type Snapshot = Awaited<ReturnType<typeof validSnapshot>>;
  type Breaking = (snapshot: Snapshot) => unknown;

  const withGroup =
    (change: (group: Record<string, unknown>) => Record<string, unknown>): Breaking =>
    (snapshot) => ({ ...snapshot, groups: snapshot.groups.map(change) });

  const withDocument =
    (change: (document: Record<string, unknown>) => unknown): Breaking =>
    (snapshot) => ({ ...snapshot, personal: snapshot.personal.map(change) });

  const firstRecord = (group: Record<string, unknown>) =>
    (group.log as Record<string, unknown>[])[0] ?? {};
  const lastRecord = (group: Record<string, unknown>) =>
    (group.log as Record<string, unknown>[]).at(-1) ?? {};

  /** `record` at the next seq, with one byte of its signature (bytes 32–95) changed. */
  const forgedCopy = (record: Record<string, unknown>) => {
    const bytes = Uint8Array.from(fromBase64url(String(record.bytes)));
    bytes[40] = (bytes[40] ?? 0) ^ 0x01;
    return { ...record, seq: Number(record.seq) + 1, bytes: base64url(bytes) };
  };

  const breakings: readonly (readonly [string, Breaking])[] = [
    ['another format', (snapshot) => ({ ...snapshot, format: 2 })],
    ['no groups list', (snapshot) => ({ format: snapshot.format })],
    [
      'the same group twice',
      (snapshot) => ({ ...snapshot, groups: [...snapshot.groups, ...snapshot.groups] }),
    ],
    ['a group that isn’t an object', (snapshot) => ({ ...snapshot, groups: ['group'] })],
    ['a group id of another shape', withGroup((group) => ({ ...group, groupId: 'short' }))],
    [
      'a secret of 31 bytes',
      withGroup((group) => ({ ...group, secret: base64url(new Uint8Array(31)) })),
    ],
    [
      'a signing key that isn’t base64url',
      withGroup((group) => ({ ...group, signingKey: '!!!!' })),
    ],
    [
      'a signing key in non-canonical base64url',
      withGroup((group) => ({ ...group, signingKey: `${String(group.signingKey)}=` })),
    ],
    [
      'an author the signing key doesn’t make',
      withGroup((group) => ({ ...group, me: { ...(group.me as object), author: 'x'.repeat(43) } })),
    ],
    [
      'a name that isn’t text',
      withGroup((group) => ({ ...group, me: { ...(group.me as object), name: 7 } })),
    ],
    ['a log that isn’t a list', withGroup((group) => ({ ...group, log: {} }))],
    [
      'a record that isn’t a signed event',
      withGroup((group) => ({
        ...group,
        log: [{ ...firstRecord(group), bytes: base64url(utf8('{"forged":true}')) }],
      })),
    ],
    [
      // The fold would skip it and still find the group: only checking each record catches it.
      'a valid log with one more record whose signature doesn’t verify',
      withGroup((group) => ({
        ...group,
        log: [...(group.log as unknown[]), forgedCopy(lastRecord(group))],
      })),
    ],
    [
      'a record with a fractional seq',
      withGroup((group) => ({ ...group, log: [{ ...firstRecord(group), seq: 1.5 }] })),
    ],
    [
      'a record with a negative receipt time',
      withGroup((group) => ({ ...group, log: [{ ...firstRecord(group), received: -1 }] })),
    ],
    ['a log of another group', withGroup((group) => ({ ...group, groupId: 'A'.repeat(43) }))],
    ['a cursor that isn’t a whole number', withGroup((group) => ({ ...group, cursor: '9' }))],
    ['a relay time that isn’t a whole number', withGroup((group) => ({ ...group, relayNow: 1.5 }))],
    ['an instance that isn’t text', withGroup((group) => ({ ...group, instance: 4 }))],
    [
      'a last sync that isn’t a whole number',
      withGroup((group) => ({ ...group, lastSyncAt: 'now' })),
    ],
    [
      'a missing-history flag that isn’t true or false',
      withGroup((group) => ({ ...group, missingHistory: 'no' })),
    ],
    ['a personal field that isn’t a list', (snapshot) => ({ ...snapshot, personal: {} })],
    ['a personal field of null', (snapshot) => ({ ...snapshot, personal: null })],
    ['a personal Document that isn’t an object', withDocument(() => 'statement')],
    [
      'the same personal Document twice',
      (snapshot) => ({ ...snapshot, personal: [...snapshot.personal, ...snapshot.personal] }),
    ],
    [
      'a personal id of 15 bytes',
      withDocument((document) => ({ ...document, id: base64url(new Uint8Array(15)) })),
    ],
    ['a blank personal title', withDocument((document) => ({ ...document, title: '' }))],
    [
      'a personal title of 121 code points',
      withDocument((document) => ({ ...document, title: 'x'.repeat(121) })),
    ],
    [
      'personal text that isn’t text',
      withDocument((document) => ({ ...document, text: ['Canary'] })),
    ],
    [
      'a personal edit time that isn’t a whole number',
      withDocument((document) => ({ ...document, updatedAt: 1.5 })),
    ],
    [
      'a personal Document missing its creation time',
      withDocument((document) =>
        Object.fromEntries(Object.entries(document).filter(([key]) => key !== 'createdAt')),
      ),
    ],
  ];

  it.each(breakings)('refuses %s, and writes nothing', async (_name, breaking) => {
    const broken = breaking(await validSnapshot());
    const file = await sealBackup(utf8(JSON.stringify(broken)), PASSPHRASE, CHEAP);
    const second = await otherDevice('second');
    const before = await dump(second);

    await expect(importGroups(second, file, PASSPHRASE)).rejects.toThrow(new BackupUnreadable());

    expect(await dump(second)).toEqual(before);
  });

  it.each([
    ['bytes that aren’t UTF-8', Uint8Array.of(0xff, 0xfe, 0x7b)],
    ['text that isn’t JSON', utf8('{"format":1,')],
    ['JSON that isn’t an object', utf8('[1]')],
  ])('refuses %s', async (_name, plaintext) => {
    const file = await sealBackup(plaintext, PASSPHRASE, CHEAP);

    await expect(importGroups(await otherDevice(), file, PASSPHRASE)).rejects.toThrow(
      new BackupUnreadable(),
    );
  });

  it('accepts the valid snapshot these tests break, so each refusal is the change’s', async () => {
    const snapshot = await validSnapshot();
    const file = await sealBackup(utf8(JSON.stringify(snapshot)), PASSPHRASE, CHEAP);
    const second = await otherDevice();

    expect(snapshot.personal).toHaveLength(2);
    expect(await importGroups(second, file, PASSPHRASE)).toBe(1);
    expect(await second.listPersonal()).toEqual([canaryStatement(), READING]);
  });

  it('accepts a group that never synced, with no relay time or instance yet', async () => {
    const snapshot = await validSnapshot();
    const unsynced = withGroup((group) => ({
      ...group,
      relayNow: null,
      instance: null,
      lastSyncAt: null,
    }));
    const file = await sealBackup(utf8(JSON.stringify(unsynced(snapshot))), PASSPHRASE, CHEAP);
    const second = await otherDevice();

    expect(await importGroups(second, file, PASSPHRASE)).toBe(1);
    const restored: Group | undefined = (await second.listGroups()).find(
      (group) => group.groupId !== 'unrelated-group',
    );
    expect([restored?.relayNow, restored?.instance, restored?.lastSyncAt]).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe('the backup file’s bytes', () => {
  it('hold no group name, display name, Atom text, title, personal Document, key or secret in any spelling', async () => {
    const device = await openStore('ana');
    const group = await keepCanary(device);
    await device.savePersonal(canaryStatement());
    const canaries = [
      textCanary('group name', CANARY.group),
      textCanary('founder’s name', CANARY.founder),
      textCanary('joiner’s name', CANARY.joiner),
      textCanary('Atom text', CANARY.atom),
      textCanary('Proposal title', CANARY.title),
      textCanary('personal title', CANARY.personalTitle),
      textCanary('personal text', CANARY.personalText),
      ...keyCanaries('signing key', group.secretKey),
      ...keyCanaries('group secret', group.secret),
    ];

    const { file } = await exportGroups(device, PASSPHRASE, CHEAP);

    // The plaintext holds every canary, so the scan can’t pass by looking at nothing.
    const plaintext = await snapshotOf(device);
    const inPlaintext = new Set(
      findCanaries(plaintext, canaries).map((line) => line.split(', as')[0]),
    );
    expect([...inPlaintext].sort()).toEqual(canaries.map(({ label }) => label).sort());
    expect(findCanaries(file, canaries)).toEqual([]);
  });
});
