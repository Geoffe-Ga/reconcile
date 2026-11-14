/**
 * A Dispatch card's meta line, "From <sender> · <date>" (#453): the
 * separator and the date travel as one, joined to the sender's last word, so
 * when the line wraps on a phone no line starts with "·". It reads as before
 * when it fits, and a screen reader hears the same words.
 *
 * jsdom lays nothing out, so the tests pin the markup and the stylesheet that
 * do it; the real browser's wrap is checked in #453's screenshots at 390px.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import appCss from '../styles/app.css?raw';
import { axeViolations } from '../test/axe';
import { groupLog } from '../test/votes';
import { DispatchCard } from './DispatchCard';
import { formatDay } from './format';
import { messages } from './messages';

/** A Proposal title long enough to wrap the meta line on a 390px phone. */
const LONG = 'Garden day moves to Saturday: soup, tools, and a lift for anyone who needs one';

/** One CSS rule's body from a stylesheet, by its exact selector. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`No rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

/** A group with two Dispatches: Ana's own, and one a long-titled Proposal carried. */
function dispatches() {
  const log = groupLog();
  log.dispatch('Ana', { title: 'Meet on Sunday', text: '' });
  const proposal = log.propose('Ana', {
    title: LONG,
    dispatch: { title: 'Updated: House rules', text: '' },
  });
  log.vote('Ana', proposal, 4);
  log.vote('Ben', proposal, 4);
  const state = log.state();
  const [own, carried] = state.dispatches;
  if (own === undefined || carried === undefined) throw new Error('Expected two Dispatches.');
  return { state, own, carried };
}

/** Renders one Dispatch card on a page of its own, and returns its meta line. */
function metaOf(which: 'own' | 'carried'): HTMLElement {
  const { state, ...cards } = dispatches();
  const dispatch = cards[which];
  document.title = 'Dispatches · Reconcile';
  render(
    <main>
      <h1>Dispatches</h1>
      <DispatchCard state={state} dispatch={dispatch} level={2} />
    </main>,
  );
  const meta = screen.getByRole('article').querySelector('.dispatch-meta');
  if (!(meta instanceof HTMLElement)) throw new Error('Expected the meta line.');
  return meta;
}

/** What a screen reader reads of `element`: its text, less what's aria-hidden. */
function spoken(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent;
}

describe('DispatchCard’s meta line (#453)', () => {
  it.each([
    ['a Proposal carried', 'carried', `From the Proposal ‘${LONG}’`],
    ['a member sent', 'own', 'From Ana'],
  ] as const)(
    'keeps the separator with the date it leads, joined to the sender, on a Dispatch %s',
    (_, which, from) => {
      const meta = metaOf(which);

      // Two parts with nothing between them, not even a space to break at.
      const [sender, when, ...rest] = Array.from(meta.childNodes);
      expect(rest).toEqual([]);
      expect(sender).toHaveTextContent(from, { normalizeWhitespace: false });
      if (!(when instanceof HTMLElement)) throw new Error('Expected the date’s part.');
      expect(when).toHaveClass('dispatch-when');

      // In it, the screen readers' separator, the dot, and the date.
      const [hidden, dot, time] = Array.from(when.children);
      expect(hidden?.textContent).toBe(messages.home.levelSeparator);
      expect(dot).toHaveAttribute('aria-hidden', 'true');
      expect(dot).toHaveClass('dispatch-separator');
      expect(dot?.textContent).toBe(messages.dispatches.dateSeparator);
      expect(time?.tagName).toBe('TIME');
      expect(when.children).toHaveLength(3);
    },
  );

  it('lays the line out as text, so the date’s part waits on the sender’s last line', () => {
    // A flex row would move the dot and date to a line of their own, the dot first.
    expect(rule(appCss, '.dispatch-meta')).not.toContain('display:');
    expect(rule(appCss, '.dispatch-when')).toContain('white-space: nowrap');
    // The same space either side of the dot as the flex row's gap gave.
    expect(rule(appCss, '.dispatch-separator')).toContain('margin-inline: var(--space-2)');
    // A word joiner before the dot: no line breaks there, whatever script the sender ends in.
    expect(rule(appCss, '.dispatch-separator::before')).toContain("content: '\\2060'");
  });

  it('reads the same to a screen reader: the sender, a comma, then the date', () => {
    const { carried } = dispatches();
    const meta = metaOf('carried');
    expect(spoken(meta)).toBe(`From the Proposal ‘${LONG}’,${formatDay(carried.received)}`);
  });

  it('passes axe', async () => {
    metaOf('carried');
    expect(await axeViolations()).toEqual([]);
  });
});
