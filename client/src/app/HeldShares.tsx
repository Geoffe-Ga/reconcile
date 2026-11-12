/**
 * The recovery shares this device holds (#109): "You're holding a recovery
 * share for <name> (<group>)", and nothing else about the share or its split.
 * Settings › Recovery contacts lists every one; a group's home shows its own
 * once, as a quiet inline card the person puts away with OK, never a modal
 * (ADR-0018: protective features stay quiet). Names and group names sit in
 * `<bdi>`, as everywhere a person's words show.
 */
import { Button } from 'react-aria-components';

import type { HeldShare } from '../store/recovery';
import { messages } from './messages';

/** One held share's line: whose, and in which group. */
function HoldingLine({ share }: { readonly share: HeldShare }) {
  const { holdingBefore, groupOpen, groupClose } = messages.recovery;
  return (
    <>
      {holdingBefore} <bdi>{share.name}</bdi> {groupOpen}
      <bdi>{share.groupName}</bdi>
      {groupClose}
    </>
  );
}

/** Every held share, one line each, or nothing for none. */
export function HeldShares({ held }: { readonly held: readonly HeldShare[] }) {
  return held.length === 0 ? null : (
    <ul className="recovery-held">
      {held.map((share) => (
        <li key={share.id}>
          <HoldingLine share={share} />
        </li>
      ))}
    </ul>
  );
}

/** Props for {@link HeldShareCard}. */
export interface HeldShareCardProps {
  /** The group's held shares its home hasn't shown yet. */
  readonly held: readonly HeldShare[];
  /** Puts these lines away for good, by their event ids. */
  readonly onDismiss: (ids: readonly string[]) => Promise<void>;
}

/** Group home's quiet card: the same lines, once, and OK. Nothing for none. */
export function HeldShareCard({ held, onDismiss }: HeldShareCardProps) {
  return held.length === 0 ? null : (
    <div className="backup-slot">
      <div className="backup-card recovery-card">
        <HeldShares held={held} />
        <Button
          className="button button-quiet"
          onPress={() => {
            // A failed write leaves the card up, to answer again.
            onDismiss(held.map(({ id }) => id)).catch(() => undefined);
          }}
        >
          {messages.recovery.dismiss}
        </Button>
      </div>
    </div>
  );
}
