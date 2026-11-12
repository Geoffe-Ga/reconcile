/**
 * What a seized device that is still locked holds in the clear (#391, S3;
 * docs/plan/12_Security_Privacy_Threat_Model.md). The passkey vault (#95)
 * seals every key, so a scan of the locked device's database finds none. It
 * doesn't seal what the device keeps beside them: a group's log, the
 * recovery contacts list, a held recovery code and a read application's reply
 * seed. This pins that boundary, so the threat model's list stays true: a key
 * found in the clear, or a change that seals one of these, fails here.
 */
import { describe, expect, it } from 'vitest';

import { vaultKeyFromPrf } from '../crypto/keyVault';
import { concat, utf8 } from '../test/bytes';
import { freshIndexedDBPerTest } from '../test/idb';
import { type Canary, findCanaries, keyCanaries } from '../test/scan';
import { scanDb } from '../test/scanDb';
import { DATABASE_NAME, type NewGroup, openStore, VaultLocked } from './db';

freshIndexedDBPerTest();

const SALT = new Uint8Array(32).fill(0x33);
const KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x11), SALT);
const LOCK = { credentialId: Uint8Array.of(1, 2, 3, 4), prfSalt: SALT };

const GROUP: NewGroup = {
  groupId: 'group-ana',
  secret: Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) % 256),
  signingKey: Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 2) % 256),
  kxKey: Uint8Array.from({ length: 32 }, (_, i) => (i * 17 + 3) % 256),
  me: { author: 'author-ana', name: 'Ana' },
};
const BACKUP_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 19 + 4) % 256);

/** What the device keeps in the clear, each a word no key or id holds. */
const LOG_WORDS = 'Canary ballot for removing Ben';
const CONTACT = 'Canary Contact Cal';
const HELD_CODE = 'canary-held-recovery-code';
const REPLY_SEED = 'canary-applicant-reply-seed';

/** Every key the vault seals, in every spelling the scan knows. */
const KEYS: readonly Canary[] = [
  ...keyCanaries('group secret', GROUP.secret),
  ...keyCanaries('signing key', GROUP.signingKey),
  ...keyCanaries('encryption key', GROUP.kxKey ?? new Uint8Array(0)),
  ...keyCanaries('relay backup key', BACKUP_KEY),
];

/** A sealed device holding a group with each of those things, in a new session, still locked. */
async function lockedDevice() {
  const store = await openStore();
  await store.addGroup(GROUP);
  await store.setRelayBackupKey(BACKUP_KEY);
  await store.sealKeys(LOCK, KEY);
  const groupId = GROUP.groupId;
  const record = { seq: 1, received: 29_000_000, bytes: utf8(`{"note":"${LOG_WORDS}"}`) };
  await store.mergeLog(groupId, [record], () => 'event-1');
  await store.setRecoveryPlan({
    split: 'split-of-a-locked-device',
    t: 2,
    n: 3,
    contacts: [{ groupId, member: 'author-cal', name: CONTACT, groupName: 'Riverside' }],
    chosenAt: 1,
    retired: [],
  });
  await store.holdShare(groupId, utf8('{"alert":1}'), {
    alert: 'alert-1',
    person: 'author-ben',
    split: 'split-of-ben',
    tag: 'tag-1',
    code: HELD_CODE,
    approvedAt: 1,
  });
  await store.updateInbox(groupId, () => ({
    inbox: 'inbox-1',
    cursor: 1,
    instance: null,
    applications: [
      {
        id: 'application-1',
        seq: 1,
        received: 29_000_001,
        name: 'Dee',
        message: 'Hello.',
        reply: { seed: REPLY_SEED, key: 'reply-key' },
      },
    ],
  }));
  store.close();
  return openStore();
}

/** Every key and value in the database, as raw bytes. */
async function rawDatabase(): Promise<Uint8Array> {
  const { text, bytes } = await scanDb(DATABASE_NAME);
  return concat(utf8(text), ...bytes.flatMap((held) => [Uint8Array.of(0), held]));
}

describe('a seized device that is still locked (#391)', () => {
  it('holds no key in the clear, in any spelling', async () => {
    const store = await lockedDevice();

    await expect(store.listGroups()).rejects.toThrow(VaultLocked);
    expect(findCanaries(await rawDatabase(), KEYS)).toEqual([]);
    store.close();
  });

  it('holds the log, the contacts list, a held code and a reply seed in the clear, as the threat model says', async () => {
    (await lockedDevice()).close();
    const { text } = await scanDb(DATABASE_NAME);

    expect([LOG_WORDS, CONTACT, HELD_CODE, REPLY_SEED].map((word) => text.includes(word))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});
