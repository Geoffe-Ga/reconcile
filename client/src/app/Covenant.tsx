/**
 * The covenant a listing accepts, as the listing composer and the ballot show
 * it (#485; ADR-0081 §3; docs/spec/listed-doors.md §3.1 and §3.2): its
 * clauses, marked a draft while they are one, and the plain line on what
 * listing makes public. A hash this app carries no words for says so, and
 * never shows other words in their place.
 */
import { useId } from 'react';
import { Heading } from 'react-aria-components';

import { covenantOf } from '../shelf/covenant';
import { messages } from './messages';

/** Props for {@link CovenantText}. */
export interface CovenantTextProps {
  /** The covenant's hash, as the listing carries it. */
  readonly hash: string;
  /** Its heading's level: 2 on a composer, 4 inside a ballot's card. */
  readonly level: 2 | 4;
}

/** The covenant `hash` names, its draft mark and what listing exposes. */
export function CovenantText({ hash, level }: CovenantTextProps) {
  const heading = useId();
  const words = messages.covenant;
  const covenant = covenantOf(hash);
  return (
    <section className="stack covenant" aria-labelledby={heading}>
      <Heading id={heading} level={level} className="heading-3">
        {words.heading}
        {covenant?.draft === true ? (
          <span className="badge covenant-draft">{words.draft}</span>
        ) : null}
      </Heading>
      {covenant === null ? (
        <p className="caption">{words.unknown}</p>
      ) : (
        <>
          {covenant.draft ? <p className="caption">{words.draftLine}</p> : null}
          <ol className="covenant-clauses">
            {covenant.clauses.map((clause) => (
              <li key={clause}>{clause}</li>
            ))}
          </ol>
        </>
      )}
      <p className="opt-in-warning">{words.exposure}</p>
    </section>
  );
}
