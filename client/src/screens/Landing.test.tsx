import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { Landing } from './Landing';

const text = messages.landing;

/** jsdom has no layout, so it has no scrollIntoView: stand one in and watch it. */
const scrollIntoView = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  scrollIntoView.mockReset();
  window.history.replaceState(null, '', '/');
});

function setup() {
  const onStart = vi.fn();
  render(<Landing onStart={onStart} />);
  return { user: userEvent.setup(), onStart };
}

const heading = (name: string, level = 2) => screen.getByRole('heading', { level, name });

describe('Landing', () => {
  it('leads with the word itself, defined, and what a Group can do', () => {
    setup();
    expect(heading(text.title, 1)).toBeVisible();
    expect(screen.getByText(text.definition, { exact: false })).toBeVisible();
    expect(screen.getByText(text.lede)).toBeVisible();
    for (const point of text.points) expect(screen.getByText(point)).toBeVisible();
  });

  it('explains each feature through its case study, in page order', () => {
    setup();
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual([
      text.dispatch.title,
      text.reconcile.title,
      text.documents.title,
      text.privacy.title,
      text.network.title,
      text.begin.title,
    ]);
  });

  it('tells the Dispatch’s journey as steps, each saying how its vote came out', () => {
    setup();
    const steps = screen.getByRole('list', { name: text.dispatch.stepsLabel });
    const items = within(steps).getAllByRole('listitem');
    expect(items).toHaveLength(text.dispatch.steps.length);
    text.dispatch.steps.forEach((step, index) => {
      const item = items[index];
      if (item === undefined) throw new Error('A Dispatch step is missing.');
      expect(within(item).getByText(step.where)).toBeVisible();
      expect(within(item).getByRole('heading', { level: 3, name: step.title })).toBeVisible();
      expect(within(item).getByText(step.verdict)).toBeVisible();
    });
    expect(screen.getByText(text.dispatch.takeaway)).toBeVisible();
  });

  it('says in words what the two Groups share and what divides them', () => {
    setup();
    for (const line of text.reconcile.tally) {
      expect(screen.getByText(line.lead)).toBeVisible();
      expect(screen.getByText(line.rest, { exact: false })).toBeVisible();
    }
    for (const line of text.reconcile.then) expect(screen.getByText(line)).toBeVisible();
  });

  it('shows the ballot scale with each score and its label, and the three levels', () => {
    setup();
    const scale = screen.getByRole('list', { name: text.documents.scaleLabel });
    const scores = within(scale).getAllByRole('listitem');
    expect(scores.map((item) => item.textContent)).toEqual(
      messages.ballot.scores.map((label, score) => `${String(score)} ${label}`),
    );
    const kinds = screen.getByRole('list', { name: text.documents.kindsLabel });
    expect(within(kinds).getAllByRole('listitem')).toHaveLength(text.documents.kinds.length);
    for (const level of messages.levels.names) expect(screen.getByText(level)).toBeVisible();
  });

  it('starts first run from either Start a Group button', async () => {
    const { user, onStart } = setup();
    const buttons = screen.getAllByRole('button', { name: text.start });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) await user.click(button);
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it.each([
    [text.nav.dispatch, text.dispatch.title],
    [text.nav.reconcile, text.reconcile.title],
    [text.nav.documents, text.documents.title],
    [text.nav.privacy, text.privacy.title],
    [text.seeIt, text.dispatch.title],
  ])('jumps from %s to its section, and moves focus to the heading', async (link, title) => {
    const { user } = setup();
    const nav =
      link === text.seeIt
        ? screen.getByRole('button', { name: link })
        : within(screen.getByRole('navigation', { name: text.nav.label })).getByRole('button', {
            name: link,
          });
    await user.click(nav);
    expect(heading(title)).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // Routes live after `#`: a jump never writes there.
    expect(window.location.hash).toBe('');
  });

  it('creates nothing and stores nothing', () => {
    setup();
    expect(window.localStorage.length).toBe(0);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
