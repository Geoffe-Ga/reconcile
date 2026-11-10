/**
 * The passkey offer (#95): shown once after the pilot notice, on a device
 * where a passkey can lock the keys, and always in Settings after that.
 *
 * It says what a passkey protects against, that the phone asks twice the
 * first time, and what the password manager learns. Not now closes it, and
 * so does Continue once setup has ended; either way this device doesn't ask
 * again (`platform/passkeyOffer.ts`).
 */
import { useState } from 'react';
import { Button } from 'react-aria-components';

import { messages } from '../app/messages';
import type { Passkey } from '../app/passkey';
import { PasskeySetup } from '../app/PasskeySetup';
import { PageHeader } from '../app/ui';

/** Props for {@link PasskeyOffer}. */
export interface PasskeyOfferProps {
  /** Passkey setup on this device. */
  readonly passkey: Passkey;
  /** Records the offer as answered and opens the app. */
  readonly onDone: () => void;
}

/** Lock your keys with a passkey, or Not now. */
export function PasskeyOffer({ passkey, onDone }: PasskeyOfferProps) {
  const [ended, setEnded] = useState(false);
  const words = messages.passkey;
  return (
    <main className="shell">
      <PageHeader title={words.title} pageTitle={words.pageTitle} />
      <div className="stack">
        <p className="lede">{words.lede}</p>
        <p className="lede">{words.twice}</p>
        <p className="lede">{words.privacy}</p>
      </div>
      <PasskeySetup
        onCreate={() => passkey.create()}
        onProtect={(id) => passkey.protect(id)}
        onEnd={() => {
          setEnded(true);
        }}
        linkBackup
        onBackup={onDone}
      />
      <div>
        <Button
          className={ended ? 'button button-primary' : 'button button-quiet'}
          onPress={onDone}
        >
          {ended ? words.continue : words.notNow}
        </Button>
      </div>
    </main>
  );
}
