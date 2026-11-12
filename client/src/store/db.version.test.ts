/**
 * The database's version moves with the vault's format (#391, F6). A build
 * from before a vault format would read that vault as one that doesn't open,
 * and offer Restore, which clears it. With the version bumped, such a build,
 * as after a rolled-back deploy, can't open the database at all.
 */
import { deleteDB, openDB } from 'idb';
import { describe, expect, it } from 'vitest';

import { freshIndexedDBPerTest } from '../test/idb';
import { DATABASE_NAME, openStore } from './db';
import { VAULT_FORMAT } from './vault';

freshIndexedDBPerTest();

/**
 * Each vault format and the database version that came with it. A new format
 * needs a row here, with a version above the last, and the store at it.
 */
const FORMAT_VERSIONS: readonly (readonly [format: number, version: number])[] = [
  [1, 6],
  [2, 8],
];

/** The version the store opens its database at. */
async function storeVersion(): Promise<number> {
  (await openStore()).close();
  const db = await openDB(DATABASE_NAME);
  try {
    return db.version;
  } finally {
    db.close();
  }
}

describe('the database version and the vault format (#391)', () => {
  it('bumps the version with each vault format, so the store opens at the latest format’s version', async () => {
    const versions = FORMAT_VERSIONS.map(([, version]) => version);
    const [format, version] = FORMAT_VERSIONS.at(-1) ?? [0, 0];

    expect(format).toBe(VAULT_FORMAT);
    expect(versions).toEqual([...new Set(versions)].sort((a, b) => a - b));
    expect(await storeVersion()).toBe(version);
  });

  it('leaves a build from before the current format unable to open the database, not reading its vault as one that doesn’t open', async () => {
    (await openStore()).close();
    const before = FORMAT_VERSIONS.at(-2)?.[1] ?? 0;

    await expect(openDB(DATABASE_NAME, before)).rejects.toMatchObject({ name: 'VersionError' });
    await expect(openDB(DATABASE_NAME, 7)).rejects.toMatchObject({ name: 'VersionError' });
  });

  it('upgrades a version 7 database, keeping its stores as they were', async () => {
    const old = await openDB(DATABASE_NAME, 7, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
        for (const name of ['personal', 'vault', 'sent']) {
          database.createObjectStore(name, { keyPath: 'id' });
        }
        database.createObjectStore('device');
      },
    });
    await old.put('device', { retiredAt: 5 }, 'relay-backup-retired');
    old.close();

    const store = await openStore();
    expect(await store.getRelayBackupRetiredAt()).toBe(5);
    store.close();
    await deleteDB(DATABASE_NAME);
  });
});
