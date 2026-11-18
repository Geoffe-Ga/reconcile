/**
 * A vote link's screen, `#vote/{token}` (#472, ADR-0079 §3).
 *
 * It looks for the Proposal the token names among this device's groups. On
 * a match it hands it to `onFound`, which opens the Proposal's page in its
 * place, so Back skips this screen. With no match it waits for the sync pass
 * under way, since the vote may not have reached the device yet, then looks
 * once more. Only then does it say the vote isn't on this device: one line
 * that never varies with the token, so it hints at no group, and not at
 * whether the token was ever real. A back link to Your groups keeps it from
 * being a dead end, as a missing coalition's page does.
 */
import { useEffect, useEffectEvent, useState } from 'react';

import { messages } from '../app/messages';
import { BackLink, PageHeader } from '../app/ui';
import type { VoteTarget } from '../app/voteLink';

/** Props for {@link VoteLink}. */
export interface VoteLinkProps {
  /** Looks for the Proposal the link's token names on this device, afresh each call. */
  readonly locate: () => Promise<VoteTarget | null>;
  /** Resolves once the sync pass under way, or the next, has run; whether it reached the relay doesn't matter. */
  readonly waitForSync: () => Promise<unknown>;
  /** Opens the Proposal the token names. */
  readonly onFound: (target: VoteTarget) => void;
}

/** Where looking has got to. */
type Phase = 'looking' | 'missing';

/** Looks, then after a sync pass looks once more, and says where that left it. */
function useLookup({ locate, waitForSync, onFound }: VoteLinkProps): Phase {
  const [phase, setPhase] = useState<Phase>('looking');
  const look = useEffectEvent(() => locate());
  const sync = useEffectEvent(() => waitForSync());
  const found = useEffectEvent((target: VoteTarget) => {
    onFound(target);
  });
  useEffect(() => {
    let live = true;
    const lookTwice = async (): Promise<VoteTarget | null> => {
      const first = await look();
      if (first !== null) return first;
      // A failed pass still ends the wait: the device holds what it holds.
      await sync().catch(() => undefined);
      return look();
    };
    void lookTwice()
      .catch(() => null)
      .then((target) => {
        if (!live) return;
        if (target === null) setPhase('missing');
        else found(target);
      });
    return () => {
      live = false;
    };
  }, []);
  return phase;
}

/** Looks for the vote, and says so; then opens it, or says it isn't on this device. */
export function VoteLink(props: VoteLinkProps) {
  const phase = useLookup(props);
  const { vote } = messages;
  return (
    <main className="shell" data-scene="sky">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={vote.title} pageTitle={vote.pageTitle} />
      <p role="status" className="lede">
        {phase === 'looking' ? vote.looking : vote.missing}
      </p>
    </main>
  );
}
