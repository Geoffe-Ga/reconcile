/**
 * The backup file's contents (#78): what a backup holds of each group, what
 * it leaves out, and how a restore validates everything before it writes
 * anything, in one transaction.
 */
import { describe, expect, it } from 'vitest';

import { BackupUnreadable, sealBackup } from '../crypto/backup';
import { base64url, fromBase64url } from '../crypto/base64url';
import { fold } from '../engine/fold';
import { local, text, utf8 } from '../test/bytes';
import { testGroup } from '../test/groups';
import { freshIndexedDBPerTest } from '../test/idb';
import { testKeys } from '../test/keys';
import { findCanaries, keyCanaries, textCanary } from '../test/scan';
import { type Group, openStore, type Store } from './db';
import { eventIdOf } from './eventId';
import {
  backedUpGroups,
  encodeSnapshot,
  exportGroups,
  importGroups,
  MAX_BACKUP_BYTES,
  SNAPSHOT_FORMAT,
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

  it('leave out the outbox and drafts, so a restore never sends stale intent', async () => {
    const device = await openStore('ana');
    await keepCanary(device);
    const [group] = await device.listGroups();
    if (group === undefined) throw new Error('Expected the group.');

    const plaintext = encodeSnapshot(backedUpGroups([group]));

    expect(text(plaintext)).not.toContain('Canary outbox');
    expect(text(plaintext)).not.toContain('Canary draft');
    expect(Object.keys(JSON.parse(text(plaintext)) as object)).toEqual(['format', 'groups']);
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
  async function validSnapshot(): Promise<{ format: number; groups: Record<string, unknown>[] }> {
    const device = await openStore('ana');
    await keepCanary(device);
    return JSON.parse(text(encodeSnapshot(backedUpGroups(await device.listGroups())))) as {
      format: number;
      groups: Record<string, unknown>[];
    };
  }

  type Snapshot = Awaited<ReturnType<typeof validSnapshot>>;
  type Breaking = (snapshot: Snapshot) => unknown;

  const withGroup =
    (change: (group: Record<string, unknown>) => Record<string, unknown>): Breaking =>
    (snapshot) => ({ ...snapshot, groups: snapshot.groups.map(change) });

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
    const file = await sealBackup(utf8(JSON.stringify(await validSnapshot())), PASSPHRASE, CHEAP);

    expect(await importGroups(await otherDevice(), file, PASSPHRASE)).toBe(1);
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
  it('hold no group name, display name, Atom text, title, key or secret in any spelling', async () => {
    const device = await openStore('ana');
    const group = await keepCanary(device);
    const canaries = [
      textCanary('group name', CANARY.group),
      textCanary('founder’s name', CANARY.founder),
      textCanary('joiner’s name', CANARY.joiner),
      textCanary('Atom text', CANARY.atom),
      textCanary('Proposal title', CANARY.title),
      ...keyCanaries('signing key', group.secretKey),
      ...keyCanaries('group secret', group.secret),
    ];
    const [stored] = await device.listGroups();
    if (stored === undefined) throw new Error('Expected the group.');

    const { file } = await exportGroups(device, PASSPHRASE, CHEAP);

    // The plaintext holds every canary, so the scan can’t pass by looking at nothing.
    const plaintext = encodeSnapshot(backedUpGroups([stored]));
    const inPlaintext = new Set(
      findCanaries(plaintext, canaries).map((line) => line.split(', as')[0]),
    );
    expect([...inPlaintext].sort()).toEqual(canaries.map(({ label }) => label).sort());
    expect(findCanaries(file, canaries)).toEqual([]);
  });
});
