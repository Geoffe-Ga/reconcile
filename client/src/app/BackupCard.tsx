/**
 * Group home's backup card (#78; spec §8 Group home): a quiet inline card,
 * never a modal, for a group no backup file holds yet. Save a backup opens
 * Settings, where the file is made; Not now hides the card for this group on
 * this device. Saving or restoring a backup that holds the group hides it too.
 */
import { Button, Link } from 'react-aria-components';

import { messages } from './messages';
import { routeHref } from './router';

/** Props for {@link BackupCard}. */
export interface BackupCardProps {
  /** Hides the card for this group on this device. */
  readonly onNotNow: () => Promise<void>;
}

/** "Save a backup so you can get this group back…", with Save a backup and Not now. */
export function BackupCard({ onNotNow }: BackupCardProps) {
  return (
    <div className="backup-slot">
      <div className="backup-card">
        <p>{messages.backupCard.body}</p>
        <div className="row">
          <Link className="button button-secondary" href={routeHref({ name: 'settings' })}>
            {messages.backupCard.save}
          </Link>
          <Button
            className="button button-quiet"
            onPress={() => {
              // A failed write leaves the card up, to answer again.
              onNotNow().catch(() => undefined);
            }}
          >
            {messages.backupCard.notNow}
          </Button>
        </div>
      </div>
    </div>
  );
}
