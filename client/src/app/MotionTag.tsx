/**
 * The tag over a coalition motion in a member group (#120, #122): "Coalition
 * vote · Metro Renters", and for a motion from further up, the coalitions it
 * came through, nearest first: "Coalition vote · Metro Renters (through
 * Eastside Housing)". Each name is in its own `<bdi>`.
 */
import type { ReactNode } from 'react';

import { messages } from './messages';

/** Props for {@link MotionTagText}. */
export interface MotionTagProps {
  /** The coalition whose motion it is: for a nested one, the highest. */
  readonly coalition: string;
  /** The coalitions it came through to reach the group, nearest first. */
  readonly through: readonly string[];
}

/** The route a nested motion came through, as in "(through Eastside Housing, then Metro Renters)". */
function Through({ names }: { readonly names: readonly string[] }) {
  const { through, throughEnd, then, listSeparator } = messages.coalitions;
  const parts: ReactNode[] = [];
  names.forEach((name, index) => {
    if (index > 0) parts.push(`${listSeparator} ${then} `);
    parts.push(<bdi key={index}>{name}</bdi>);
  });
  return (
    <>
      {' '}
      {through} {parts}
      {throughEnd}
    </>
  );
}

/** "Coalition vote · <coalition>", with the route for a motion from further up (#122). */
export function MotionTagText({ coalition, through }: MotionTagProps) {
  const { voteTag, tagSeparator } = messages.coalitions;
  return (
    <>
      {voteTag} {tagSeparator} <bdi>{coalition}</bdi>
      {through.length > 0 ? <Through names={through} /> : null}
    </>
  );
}
