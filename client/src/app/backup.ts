/**
 * What Save a backup and Restore do (#78; spec §3 "Backup file", §8
 * Settings), apart from any screen.
 *
 * Making a backup seals every group on the device under the person's
 * passphrase (`store/snapshot.ts`) into one file with a generic name. Saving
 * it hands the file to the share sheet or downloads it (`share.ts`), and only
 * once it's saved are its groups marked, so group home stops suggesting a
 * backup for them. Restoring checks the whole file before it writes anything,
 * leaving out any group entry that doesn't check out and saying so (#336),
 * then syncs at once, so the restored groups catch up with the relay. The file
 * carries the device's relay backup key (#97), and a device restored from it
 * keeps the key if it has none, so its first complete sync pass refreshes the
 * relay backup.
 */
import type { Store } from '../store/db';
import { exportGroups, importGroups, type Restored } from '../store/snapshot';
import type { Sync } from '../store/sync';
import { backupFile, type FileTargets, type SaveOutcome, saveFile } from './share';
import { messages } from './messages';

/** The fewest characters a backup passphrase may have, counted as graphemes after NFC. */
export const MIN_PASSPHRASE_CHARS = 8;

/** Splits text into the characters a person sees, so é or a family emoji counts once. */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A backup file made and waiting to be saved, and the groups it holds. */
export interface BackupToSave {
  readonly file: File;
  readonly groupIds: readonly string[];
}

/** Why `passphrase` can't lock a backup, or null when it can: fewer than 8 characters after NFC. */
export function passphraseProblem(passphrase: string): string | null {
  const characters = Array.from(graphemes.segment(passphrase.normalize('NFC'))).length;
  return characters < MIN_PASSPHRASE_CHARS ? messages.backup.passphraseShort : null;
}

/**
 * Seals every group a backup keeps under `passphrase`, as a file named for
 * today on this device. It first checks this session holds the unlocked keys
 * (#95), as everything that hands keys on does.
 *
 * @throws {VaultLocked} when the device's keys are locked with a passkey this session hasn't used.
 */
export async function makeBackup(
  services: {
    readonly store: Pick<
      Store,
      'listGroups' | 'listCoalitions' | 'listPersonal' | 'getRelayBackup' | 'requireUnlocked'
    >;
    readonly now: () => number;
  },
  passphrase: string,
): Promise<BackupToSave> {
  await services.store.requireUnlocked();
  const { file, groupIds } = await exportGroups(services.store, passphrase);
  return { file: backupFile(file, new Date(services.now())), groupIds };
}

/** Saves `backup`'s file, then marks its groups as saved, unless the person closed the sheet. */
export async function saveBackup(
  services: { readonly store: Pick<Store, 'markBackup'>; readonly files: FileTargets },
  backup: BackupToSave,
): Promise<SaveOutcome> {
  const outcome = await saveFile(backup.file, services.files);
  if (outcome !== 'cancelled') await services.store.markBackup(backup.groupIds, 'saved');
  return outcome;
}

/**
 * Restores the backup in `bytes` under `passphrase`, then syncs. Returns how
 * many groups it brought back, and how many group entries it left out (#336).
 *
 * @throws {BackupUnreadable} when it doesn't open or doesn't check out; nothing is written then.
 */
export async function restoreBackup(
  services: {
    readonly store: Pick<Store, 'restoreGroups' | 'adoptRelayBackupKey'>;
    readonly sync: Pick<Sync, 'syncOnce'>;
  },
  bytes: Uint8Array,
  passphrase: string,
): Promise<Restored> {
  const restored = await importGroups(services.store, bytes, passphrase);
  void services.sync.syncOnce();
  return restored;
}
