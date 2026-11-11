/**
 * Backup files as a device that keeps a relay backup key (#97) would save
 * them. No screen makes a backup key until #109, so a test that needs one
 * opens a file the app saved with its passphrase, adds a key, and seals it
 * again: a restore then keeps that key, as `importSnapshot` does.
 */
import { readFileSync } from 'node:fs';

import { openBackup, sealBackup } from '../../src/crypto/backup';
import { expect } from './fixtures';

/**
 * The backup file at `path` with `key` added as its relay backup key, sealed
 * again under `passphrase`: what a device keeping that key would have saved.
 */
export async function withBackupKey(
  path: string,
  key: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  const plaintext = await openBackup(readFileSync(path), passphrase);
  const snapshot = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
  expect(snapshot).not.toHaveProperty('backupKey');
  const keyed = { ...snapshot, backupKey: Buffer.from(key).toString('base64url') };
  return sealBackup(new TextEncoder().encode(JSON.stringify(keyed)), passphrase);
}

/** Says the share sheet takes no files, so the app downloads a backup, as Android Chrome's does. */
export function noFileSharing(): void {
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
}
