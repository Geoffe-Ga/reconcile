/**
 * What the composers share apart from any screen (spec §8): how sending went,
 * sending once at a time, and the check on a section's new text.
 */
import { useRef, useState } from 'react';

import { normalizeAtomText } from '../engine/atomText';
import { can } from '../engine/capabilities';
import { composeOption } from '../engine/composeOption';
import type { GroupState, Proposal } from '../engine/fold';
import type { Draft } from '../store/drafts';
import { latestLink } from './latestLink';
import { messages } from './messages';
import { suspendedLine } from './stewardLines';
import type { DraftState } from './useDraft';

/** How sending went: `proposed` and `added` move on to the Proposal; the others stay on the form. */
export type ComposeOutcome = 'proposed' | 'added' | 'too-large' | 'failed';

/** Who a composer is for: the group, this member, and whether their leave waits for the relay. */
export interface Composing {
  readonly state: GroupState;
  readonly me: string;
  readonly leaving?: boolean;
}

/**
 * Why this member gets no form, or null when they get one: their leave waits
 * for the relay (#77), or they may not propose, and a suspended member reads
 * until when rather than that their level can't propose (#102).
 */
export function whyNoForm(
  props: Composing,
): { readonly title: string; readonly text: string } | null {
  const { state, me } = props;
  const { composer, leave } = messages;
  if (props.leaving === true) return { title: leave.noProposingTitle, text: leave.noProposing };
  if (can(state, me, 'propose')) return null;
  return { title: composer.notAllowedTitle, text: suspendedLine(state, me) ?? composer.notAllowed };
}

/**
 * Why no change, removal, version or move can be written for a section now,
 * or null when one can: it's eternal (#116), or a move of it (#103) or a vote
 * on its protection (#116) is open, which takes nothing more.
 */
export function whySectionWaits(
  state: GroupState,
  atomId: string,
): { readonly title: string; readonly text: string } | null {
  const { composer } = messages;
  const eternal = state.atoms.some((atom) => atom.id === atomId && atom.class === 'eternal');
  if (eternal) return { title: composer.eternalTitle, text: composer.eternal };
  const option = composeOption(state, atomId);
  if (option === 'moving') return { title: composer.movingTitle, text: composer.moving };
  return option === 'protecting'
    ? { title: composer.protectingTitle, text: composer.protecting }
    : null;
}

/** `again` when its vote lapsed, which Propose again repeats (ADR-0069), else undefined. */
export function lapsed(again: Proposal | undefined): Proposal | undefined {
  return again?.final === true && again.outcome.kind === 'lapse' ? again : undefined;
}

/**
 * Where proposing again starts: the lapsed Proposal's title, why, text, link
 * and voting time, and the Dispatch it carried, if any (#112).
 */
export function againStartOf(state: GroupState, again: Proposal): Draft {
  return {
    title: again.title,
    why: again.why,
    text: again.text,
    link: again.link ?? latestLink(state) ?? '',
    window: again.window,
    ...(again.dispatch === null ? {} : { dispatch: again.dispatch }),
  };
}

/** Refuses blank text, and text that normalizes to the section's own (spec §4). */
export function textCheck(current: string, missing: string = messages.composer.textMissing) {
  const now = normalizeAtomText(current);
  return (value: string): string | null => {
    const text = normalizeAtomText(value);
    if (text === '') return missing;
    return text === now ? messages.composer.textUnchanged : null;
  };
}

/**
 * Runs `send` once at a time, keeping the button disabled until it is done.
 * The draft holds still while the Proposal or version is queued, since
 * queuing clears it, and saves again if it couldn't be queued. A removal
 * version keeps no draft, so it passes none.
 */
export function useSend<V>(send: (values: V) => Promise<ComposeOutcome>, draft: DraftState | null) {
  const busy = useRef(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const run = async (values: V) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setFailed(false);
    // Each submit starts with no refusals, so `refused` only holds the latest answer.
    setRefused({});
    draft?.hold();
    const outcome = await send(values).catch(() => 'failed' as const);
    // What was queued leaves this screen, so the button stays disabled.
    if (outcome === 'proposed' || outcome === 'added') return;
    draft?.resume();
    busy.current = false;
    setRunning(false);
    setRefused(outcome === 'too-large' ? { text: messages.composer.tooLarge } : {});
    setFailed(outcome === 'failed');
  };
  return { run, running, failed, refused };
}
