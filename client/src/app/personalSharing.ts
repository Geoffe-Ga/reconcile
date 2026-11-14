/**
 * What a personal Document's editor asks of sharing by link (#105), on the
 * app's services: read whether it's shared, Share link, send the link on,
 * Stop sharing, post an edit once the editor closes, and Keep sharing a
 * share that waits for the person: one a restore paused (#328), or one this
 * device hasn't posted to for 30 days (#339).
 *
 * The link goes out through `shareOrCopy` with fixed words beside it, never
 * the Document's title or text, and only once the relay holds the first copy.
 * While the device's keys are locked with a passkey, a share's seed waits in
 * the vault (#255), so its editor reads it as on with no link.
 */
import {
  heardRelay,
  keepSharing,
  pauseOf,
  postEdits,
  type SharePause,
  type ShareServices,
  shareLinkOf,
  startSharing,
  stopSharing,
  type StopOutcome,
} from '../share/shareLink';
import { VaultLocked } from '../store/db';
import type { PersonalStore, ShareMark } from '../store/personal';
import { messages } from './messages';
import { type ShareOutcome, shareOrCopy, type ShareTargets } from './share';

/** A shared Document's link as its editor shows it. */
export interface ShareView {
  /**
   * The whole link, `${origin}/#share/{seed}.{publicKey}`, or null while the
   * device's keys are locked with a passkey, since its seed waits in the vault (#255).
   */
  readonly link: string | null;
  /** Whether an edit, or a failed post, hasn't reached the link yet. */
  readonly pending: boolean;
  /**
   * Why nothing goes to the link until the person chooses: a restore brought
   * the share back (#328), or this device hasn't posted to it for 30 days
   * (#339). Null while the share is live.
   */
  readonly paused: SharePause | null;
}

/** How Share link went: shared, with the link, or why not. */
export type SharingStart =
  | { readonly kind: 'shared'; readonly link: string }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'locked' };

/**
 * How Keep sharing went (#328): posted; kept, but the link hasn't caught up,
 * as when the relay can't be reached, so the next launch sends it; stopped,
 * when the mailbox held a tombstone and the share is gone; or locked, when
 * the device's keys are locked with a passkey (#255), so it's still paused.
 */
export type SharingKeep = 'posted' | 'pending' | 'stopped' | 'locked';

/** Sharing by link, for one device's personal Documents. */
export interface PersonalSharing {
  /** Document `id`'s share as stored, or null when it isn't shared; with no link while locked (#255). */
  read(id: string): Promise<ShareView | null>;
  /** Share link: posts the first copy and keeps the share, or says why not. */
  start(id: string): Promise<SharingStart>;
  /** Hands `link` to the share sheet with fixed words, or copies them instead. */
  send(link: string): Promise<ShareOutcome>;
  /** Stop sharing: posts a tombstone and drops the share, or changes nothing, as when locked (#255). */
  stop(id: string): Promise<StopOutcome>;
  /** Keep sharing a paused share (#328, #339): records the choice, then posts the latest copy. */
  keep(id: string): Promise<SharingKeep>;
  /** Posts Document `id`'s latest copy in the background if an edit waits for its link. */
  leave(id: string): void;
}

/** What sharing reaches: the share services, the app's origin, and where a link can go. */
export type SharingServices = ShareServices &
  ShareTargets & {
    /** The app's origin, which every link starts with. */
    readonly origin: string;
    /** Where a locked device still reads whether a Document is shared (#255). */
    readonly store: Pick<PersonalStore, 'listPersonalEntries'>;
  };

/**
 * A share as its editor shows it at relay minute `relayNow` (#347): `link`,
 * or null while the device's keys are locked (#255), whether an edit waits,
 * and why it's paused, if it is ({@link pauseOf}), read from its mark, so a
 * paused share reads paused either way (#328, #339).
 */
function viewOf(mark: ShareMark, link: string | null, relayNow: number | null): ShareView {
  return { link, pending: mark.pending, paused: pauseOf(mark, relayNow) };
}

/** Sharing by link on `services`. */
export function personalSharing(services: SharingServices): PersonalSharing {
  const linkOf = (share: { readonly seed: Uint8Array; readonly publicKey: Uint8Array }) =>
    shareLinkOf(services.origin, share);
  return {
    async read(id) {
      try {
        const share = (await services.store.getPersonal(id))?.share;
        if (share === undefined) return null;
        return viewOf(share, linkOf(share), await heardRelay(services));
      } catch (error) {
        if (!(error instanceof VaultLocked)) throw error;
        // Only a shared Document's read needs the vault: its mark says it's on (#255). The
        // groups' relay minutes wait in it too, so the mark's own last read measures it (#347).
        const entries = await services.store.listPersonalEntries();
        const mark = entries.find((entry) => entry.id === id)?.share;
        return mark === undefined ? null : viewOf(mark, null, null);
      }
    },
    async start(id) {
      const started = await startSharing(services, id);
      if (started.kind === 'shared') return { kind: 'shared', link: linkOf(started.link) };
      const told = started.kind === 'too-large' || started.kind === 'locked';
      return told ? started : { kind: 'failed' };
    },
    send: (link) => shareOrCopy({ text: messages.personal.share.message, url: link }, services),
    stop: (id) => stopSharing(services, id),
    async keep(id) {
      const outcome = await keepSharing(services, id);
      if (outcome === 'posted' || outcome === 'locked') return outcome;
      return outcome === 'stopped' || outcome === 'unshared' ? 'stopped' : 'pending';
    },
    leave(id) {
      // A post that fails leaves the share pending, and the next launch sends it.
      void postEdits(services, id).catch(() => undefined);
    },
  };
}
