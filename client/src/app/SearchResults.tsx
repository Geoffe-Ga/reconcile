/**
 * Search results under the link bar (#445; DESIGN.md "Link bar"): one
 * listbox, its rows under eyebrows by kind, at most five of a kind until
 * "Show all <n>" shows the rest in place. Each row is the title, one line
 * of its text with the matched words marked by weight and underline (never
 * by color alone), and where it's from, all plain text in `<bdi>`: Markdown
 * stays text.
 */
import type { Key } from 'react-aria-components';
import { Header, ListBox, ListBoxItem, ListBoxSection } from 'react-aria-components';

import { messages } from './messages';
import { type SearchResult, snippetFor, type SnippetPart } from './search';
import { MORE, type Shelf, shelvesOf } from './searchShelves';

const words = messages.search;

/** Each of `parts` with where it starts in the snippet's line, which keys it. */
function placed(parts: readonly SnippetPart[]): { part: SnippetPart; at: number }[] {
  let at = 0;
  return parts.map((part) => {
    const start = at;
    at += part.text.length;
    return { part, at: start };
  });
}

/** A snippet's text, its matched words in `<strong>`. */
function Snippet({ parts }: { readonly parts: readonly SnippetPart[] }) {
  if (parts.length === 0) return null;
  return (
    <span className="search-snippet">
      <bdi>
        {placed(parts).map(({ part, at }) =>
          part.marked ? <strong key={at}>{part.text}</strong> : part.text,
        )}
      </bdi>
    </span>
  );
}

/** Props for {@link SearchResults}. */
export interface SearchResultsProps {
  readonly results: readonly SearchResult[];
  /** What was searched for, to mark in each row's snippet. */
  readonly query: string;
  /** The eyebrows whose every row shows. */
  readonly expanded: ReadonlySet<Shelf>;
  /** A row's key: a result's record id, or a "Show all" row's (see {@link moreOf}). */
  readonly onAction: (key: Key) => void;
}

/** The results under their eyebrows. */
export function SearchResults({ results, query, expanded, onAction }: SearchResultsProps) {
  return (
    <ListBox className="link-bar-rows" aria-label={words.results} onAction={onAction}>
      {shelvesOf(results, expanded).map(({ shelf, rows, total }) => (
        <ListBoxSection key={shelf} id={shelf} className="search-shelf">
          <Header className="eyebrow search-eyebrow">{words.shelves[shelf]}</Header>
          {rows.map(({ record }) => (
            <ListBoxItem
              key={record.id}
              id={record.id}
              className="link-bar-row search-row"
              textValue={record.title}
            >
              <span className="search-title">
                <bdi>{record.title}</bdi>
              </span>
              <Snippet parts={snippetFor(record, query)} />
              {record.from === '' ? null : (
                <span className="search-from">
                  <bdi>{record.from}</bdi>
                </span>
              )}
            </ListBoxItem>
          ))}
          {total > rows.length ? (
            <ListBoxItem
              id={`${MORE}${shelf}`}
              className="link-bar-row search-more"
              textValue={words.showAll(total)}
            >
              {words.showAll(total)}
            </ListBoxItem>
          ) : null}
        </ListBoxSection>
      ))}
    </ListBox>
  );
}
