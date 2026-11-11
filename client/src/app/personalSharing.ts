/**
 * What a personal Document's editor asks of sharing by link (#105), on the
 * app's services: read whether it's shared, Share link, send the link on,
 * Stop sharing, post an edit once the editor closes, and Keep sharing a
 * share a restore paused (#328).
 *
 * The link goes out through `shareOrCopy` with fixed words beside it, never
 * the Document's title or text, and only once the relay holds the first copy.
 */
import {
  keepSharing,
  postEdits,
  type ShareServices,
  shareLinkOf,
  startSharing,
  stopSharing,
  type StopOutcome,
} from '../share/shareLink';
import { messages } from './messages';
import { type ShareOutcome, shareOrCopy, type ShareTargets } from './share';

/** A shared Document's link as its editor shows it. */
export interface ShareView {
  /** The whole link, `${origin}/#share/{seed}.{publicKey}`. */
  readonly link: string;
  /** Whether an edit, or a failed post, hasn't reached the link yet. */
  readonly pending: boolean;
  /** Whether a restore brought the share back and nothing goes to the link until the person chooses (#328). */
  readonly paused: boolean;
}

/** How Share link went: shared, with the link, or why not. */
export type SharingStart =
  | { readonly kind: 'shared'; readonly link: string }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'failed' };

/**
 * How Keep sharing went (#328): posted; kept, but the link hasn't caught up,
 * as when the relay can't be reached, so the next launch sends it; or
 * stopped, when the mailbox held a tombstone and the share is gone.
 */
export type SharingKeep = 'posted' | 'pending' | 'stopped';

/** Sharing by link, for one device's personal Documents. */
export interface PersonalSharing {
  /** Document `id`'s share as stored, or null when it isn't shared. */
  read(id: string): Promise<ShareView | null>;
  /** Share link: posts the first copy and keeps the share, or says why not. */
  start(id: string): Promise<SharingStart>;
  /** Hands `link` to the share sheet with fixed words, or copies them instead. */
  send(link: string): Promise<ShareOutcome>;
  /** Stop sharing: posts a tombstone and drops the share, or changes nothing. */
  stop(id: string): Promise<StopOutcome>;
  /** Keep sharing a share a restore paused (#328): records the choice, then posts the latest copy. */
  keep(id: string): Promise<SharingKeep>;
  /** Posts Document `id`'s latest copy in the background if an edit waits for its link. */
  leave(id: string): void;
}

/** What sharing reaches: the share services, the app's origin, and where a link can go. */
export type SharingServices = ShareServices &
  ShareTargets & {
    /** The app's origin, which every link starts with. */
    readonly origin: string;
  };

/** Sharing by link on `services`. */
export function personalSharing(services: SharingServices): PersonalSharing {
  const linkOf = (share: { readonly seed: Uint8Array; readonly publicKey: Uint8Array }) =>
    shareLinkOf(services.origin, share);
  return {
    async read(id) {
      const share = (await services.store.getPersonal(id))?.share;
      if (share === undefined) return null;
      return { link: linkOf(share), pending: share.pending, paused: share.paused === true };
    },
    async start(id) {
      const started = await startSharing(services, id);
      if (started.kind === 'shared') return { kind: 'shared', link: linkOf(started.link) };
      return started.kind === 'too-large' ? started : { kind: 'failed' };
    },
    send: (link) => shareOrCopy({ text: messages.personal.share.message, url: link }, services),
    stop: (id) => stopSharing(services, id),
    async keep(id) {
      const outcome = await keepSharing(services, id);
      if (outcome === 'posted') return 'posted';
      return outcome === 'stopped' || outcome === 'unshared' ? 'stopped' : 'pending';
    },
    leave(id) {
      // A post that fails leaves the share pending, and the next launch sends it.
      void postEdits(services, id).catch(() => undefined);
    },
  };
}
