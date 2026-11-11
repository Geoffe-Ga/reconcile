/**
 * The Dispatches view (#112): every Dispatch newest first, each with its
 * title, its text as plain pre-wrapped text, its date in relay time, who or
 * which Proposal it came from, and a link to its Document; Send a Dispatch
 * only for someone who may send one; and this device's own Dispatch while it
 * waits to send.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { formatDay } from '../app/format';
import { messages } from '../app/messages';
import { LEVELS } from '../engine/capabilities';
import { type ParsedEvent, parseRecord } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { authorOf, signedAs } from '../test/keys';
import { groupLog, type LogBuilder } from '../test/votes';
import { Dispatches, type DispatchesProps } from './Dispatches';

const [FOLLOWING, VOTING] = LEVELS;

/** Ana founds; Ben joins as a Collaborator and Kim as a Member. */
function group(): LogBuilder {
  return groupLog({ members: ['Ben', 'Kim'], levels: { Ben: VOTING, Kim: FOLLOWING } });
}

function renderDispatches(state: GroupState, me: string, props: Partial<DispatchesProps> = {}) {
  return render(<Dispatches state={state} me={authorOf(me)} pending={[]} reachable {...props} />);
}

/** Each Dispatch on screen, by its card's accessible name, in order. */
const cards = () =>
  screen.getAllByRole('article').map((card) => card.getAttribute('aria-labelledby'));

describe('Dispatches', () => {
  it('lists every Dispatch newest first, each with its title, sender, date and plain text', async () => {
    const log = group();
    log.dispatch('Ana', { title: 'Meet on Sunday', text: 'Bring a chair.\n\n  We start at 10.' });
    const sentAt = log.minute;
    log.minute += 2 * 1_440;
    const proposal = log.propose('Ana', {
      title: 'Share the tools',
      dispatch: { title: 'Updated: House rules', text: '' },
    });
    log.vote('Ana', proposal, 4);
    log.vote('Ben', proposal, 4);
    const closedAt = log.minute;
    renderDispatches(log.state(), 'kim');

    expect(screen.getByRole('heading', { level: 1, name: 'Dispatches' })).toBeVisible();
    expect(document.title).toBe('Dispatches · Reconcile');
    const [newest, oldest] = screen.getAllByRole('article');
    if (newest === undefined || oldest === undefined) throw new Error('Expected two Dispatches.');
    expect(within(newest).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Updated: House rules',
    );
    expect(newest).toHaveTextContent('From the Proposal ‘Share the tools’');
    expect(within(newest).getByRole('link', { name: 'Share the tools' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/p/${proposal}`,
    );
    expect(within(newest).getByText(formatDay(closedAt))).toBeVisible();
    expect(within(oldest).getByRole('heading', { level: 2 })).toHaveTextContent('Meet on Sunday');
    expect(oldest).toHaveTextContent('From Ana');
    const date = within(oldest).getByText(formatDay(sentAt));
    expect(date.tagName).toBe('TIME');
    expect(date).toHaveAttribute('dateTime', new Date(sentAt * 60_000).toISOString());
    // The text is kept exactly, line breaks and spaces too, for pre-wrap to show.
    const text = within(oldest).getByText(/Bring a chair\./);
    expect(text.textContent).toBe('Bring a chair.\n\n  We start at 10.');
    expect(text).toHaveClass('dispatch-text');
    expect(await axeViolations()).toEqual([]);
  });

  it('shows Markdown and links as typed: no formatting, no auto-links', () => {
    const log = group();
    log.dispatch('Ana', { title: '**Bold** title', text: 'See https://example.org and **this**.' });
    renderDispatches(log.state(), 'ben');
    const card = screen.getByRole('article');
    expect(within(card).getByText('See https://example.org and **this**.')).toBeVisible();
    expect(within(card).getByRole('heading')).toHaveTextContent('**Bold** title');
    expect(within(card).queryByRole('link')).toBeNull();
    expect(card.querySelector('strong, em, a')).toBeNull();
  });

  it('links a Dispatch that points to the Document: Open, then its title', async () => {
    const log = group();
    log.dispatch('Ana', { title: 'Read the rules', text: '', doc: log.group });
    renderDispatches(log.state(), 'kim');
    const open = screen.getByRole('link', { name: 'Open House rules' });
    expect(open).toHaveAttribute('href', `#/g/${log.group}/doc`);
    expect(await axeViolations()).toEqual([]);
  });

  it('still names someone who has left, on a Dispatch they sent before', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    log.dispatch('Cal', { title: 'Cal’s news', text: '' });
    log.leave('Cal');
    renderDispatches(log.state(), 'ana');
    expect(screen.getByRole('article')).toHaveTextContent('From Cal');
  });

  it('says plainly when there are none', async () => {
    renderDispatches(group().state(), 'kim');
    expect(screen.getByText(messages.dispatches.empty)).toBeVisible();
    expect(screen.queryAllByRole('article')).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it.each([
    ['a Co-Creator', 'ana', true],
    ['a Collaborator', 'ben', false],
    ['a Member', 'kim', false],
  ])('offers Send a Dispatch only to someone who may send one: %s', (_who, me, offered) => {
    const log = group();
    renderDispatches(log.state(), me);
    const send = screen.queryByRole('link', { name: 'Send a Dispatch' });
    expect(send !== null).toBe(offered);
    if (send !== null) expect(send).toHaveAttribute('href', `#/g/${log.group}/dispatch/new`);
  });

  it('offers no Send a Dispatch while leaving, nor in a dissolved group', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const { unmount } = renderDispatches(log.state(), 'ana', { leaving: true });
    expect(screen.queryByRole('link', { name: 'Send a Dispatch' })).toBeNull();
    unmount();
    const end = log.proposeDissolve('Ana', false);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, end, 4);
    log.minute += 1;
    log.dissolve('Ana', end);
    expect(log.state().dissolved).not.toBeNull();
    renderDispatches(log.state(), 'ana');
    expect(screen.queryByRole('link', { name: 'Send a Dispatch' })).toBeNull();
  });

  it('shows this device’s own Dispatch first while it waits to send, with where it has got to', async () => {
    const log = group();
    log.dispatch('Ana', { title: 'Older', text: '' });
    const queued = signedAs('ana', {
      type: 'dispatch',
      group: log.group,
      ts: 0,
      body: { title: 'Meet on Sunday', text: 'Bring a chair.' },
    });
    const parsed = parseRecord(queued.record);
    if (parsed === null) throw new Error('Expected a signed Dispatch.');
    const pending: ParsedEvent[] = [parsed];
    const { rerender } = renderDispatches(log.state(), 'ana', { pending, reachable: false });
    const [waiting, older] = screen.getAllByRole('article');
    expect(waiting).toHaveTextContent('Meet on Sunday');
    expect(waiting).toHaveTextContent('Bring a chair.');
    expect(within(waiting ?? document.body).getByRole('status')).toHaveTextContent(
      messages.send.saved,
    );
    expect(older).toHaveTextContent('Older');
    expect(await axeViolations()).toEqual([]);
    rerender(<Dispatches state={log.state()} me={authorOf('ana')} pending={pending} reachable />);
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(messages.send.sending);
  });

  it('shows a Dispatch once, when its copy is back from the relay though the outbox still holds it', () => {
    const log = group();
    const id = log.dispatch('Ana', { title: 'Meet on Sunday', text: '' });
    const record = log.records.at(-1)?.bytes ?? new Uint8Array();
    const parsed = parseRecord(record);
    if (parsed === null) throw new Error('Expected the Dispatch.');
    expect(parsed.id).toBe(id);
    renderDispatches(log.state(), 'ana', { pending: [parsed] });
    expect(cards()).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows no one else’s outbox event, and no other kind', () => {
    const log = group();
    const other = signedAs('ben', {
      type: 'dispatch',
      group: log.group,
      ts: 0,
      body: { title: 'Not mine', text: '' },
    });
    const vote = signedAs('ana', {
      type: 'level',
      group: log.group,
      ts: 0,
      body: { level: VOTING },
    });
    const pending = [other, vote]
      .map((event) => parseRecord(event.record))
      .filter((e) => e !== null);
    renderDispatches(log.state(), 'ana', { pending });
    expect(screen.queryAllByRole('article')).toEqual([]);
  });
});
