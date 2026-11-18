/**
 * `keepKeys` is the store's one writer of key material (#95, #391): a guard
 * that makes it structural. Every method the store has is listed here, by
 * what it may write. A new method fails this test until someone decides, and
 * writes down, which kind it is, so one that writes a key doesn't slip in
 * beside `keepKeys`.
 */
import { describe, expect, it } from 'vitest';

import { freshIndexedDBPerTest } from '../test/idb';
import { openStore, type Store } from './db';

freshIndexedDBPerTest();

/**
 * Methods that write key material: each only through `keepKeys`, in one key
 * transaction (`writeKeys`), or, for `sealKeys`, `unlock` and
 * `replaceGroups`, by making, sealing into or replacing the vault itself.
 */
const KEY_WRITERS = [
  'addGroup',
  'addSent',
  'adoptEpoch',
  'adoptRelayBackupKey',
  'applyPull',
  'deletePersonal',
  'dropRecoverRequest',
  'dropSent',
  'dropStewardKey',
  'ensureKx',
  'finishRecovery',
  'keepRecoverRequest',
  'keepStewardKey',
  'purgeGroup',
  'replaceGroups',
  'restoreGroups',
  'retireRelayBackup',
  'sealKeys',
  'setRelayBackupKey',
  'unlock',
  'updateRelayBackup',
  'updateSent',
  'updateShare',
] as const satisfies readonly (keyof Store)[];

/** Methods that write records, but never a key: no group's, no share's, reply's or request's. */
const RECORD_WRITERS = [
  'claimChat',
  'dismissRemoval',
  'clearArchive',
  'clearBallots',
  'endHold',
  'enqueue',
  'enqueueAll',
  'forgetHoldCode',
  'holdShare',
  'markArchived',
  'markBackup',
  'markLeaving',
  'markNudged',
  'markRecoverySeen',
  'markRetiredChecked',
  'keepShelfCopy',
  'keepStewardInbox',
  'mergeLog',
  'noteChatChannel',
  'noteSentCard',
  'planCoalition',
  'removalsAt',
  'savePersonal',
  'setPush',
  'setHoldNumber',
  'setRecoveryPlan',
  'settleChatClaim',
  'updateCarried',
  'updateInbox',
  'updatePushForgets',
  'writeDraft',
] as const satisfies readonly (keyof Store)[];

/** Methods that write nothing. */
const READERS = [
  'close',
  'getGroup',
  'getPersonal',
  'getRecoverRequest',
  'getRecoveredAt',
  'getRecoveryPlan',
  'getRelayBackup',
  'getRelayBackupRetiredAt',
  'getShelfCopy',
  'getStewardInbox',
  'getStewardKey',
  'holdsStewardKey',
  'listCoalitions',
  'listGroups',
  'listPersonal',
  'listPersonalEntries',
  'listPushForgets',
  'listRooms',
  'listSent',
  'readDraft',
  'readVault',
  'requireUnlocked',
  'subscribe',
] as const satisfies readonly (keyof Store)[];

describe('who writes key material (#391)', () => {
  it('lists every method the store has as a key writer, a record writer or a reader, once', async () => {
    const store = await openStore();
    const listed: readonly (keyof Store)[] = [...KEY_WRITERS, ...RECORD_WRITERS, ...READERS];

    expect(new Set(listed).size).toBe(listed.length);
    expect(Object.keys(store).sort()).toEqual([...listed].sort());
    store.close();
  });
});
