/**
 * One entry on the public shelf as a card (#484, #431; listed-doors.md
 * §5.2), on Discover and on the entry's own page: its listing's name in
 * `<bdi>`, then its title and text as a Dispatch card's, and under them
 * "Listed since {month year}", and "Shows publicly tomorrow" while only its
 * own group sees it. No count, author or time of its own: an entry carries
 * none.
 */
import { type ReactNode, useId } from 'react';

import type { ShelfEntry } from '../shelf/fold';
import { messages } from './messages';
import { formatMonth } from './time';

/** Props for {@link ShelfCard}. */
export interface ShelfCardProps {
  readonly entry: ShelfEntry;
  /** The title's heading level: 3 in Discover's section, 2 on the entry's own page. */
  readonly level: 2 | 3;
  /** What follows the card's lines, such as the link to its own page; none when absent. */
  readonly children?: ReactNode;
}

/** The entry's card. */
export function ShelfCard({ entry, level, children }: ShelfCardProps) {
  const heading = useId();
  const Heading = level === 2 ? 'h2' : 'h3';
  const words = messages.discover;
  return (
    <article className="card dispatch" aria-labelledby={heading}>
      <p className="eyebrow dispatch-from">
        <bdi>{entry.name}</bdi>
      </p>
      <Heading id={heading} className="heading-3 dispatch-title">
        <bdi>{entry.title}</bdi>
      </Heading>
      {entry.text === '' ? null : (
        <p className="dispatch-text" dir="auto">
          {entry.text}
        </p>
      )}
      <p className="meta">{words.listedSince(formatMonth(entry.listedSince))}</p>
      {entry.early ? (
        <p className="meta">
          <strong>{words.showsTomorrow}</strong>
        </p>
      ) : null}
      {children}
    </article>
  );
}
