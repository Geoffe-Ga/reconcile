/**
 * A shelf entry's own page (#431, #432; listed-doors.md §5.2): Ask to join
 * opens the listing's front door, and Propose reconciling does too, only on
 * a device with a group that may propose reconciling with it (#426's rule).
 *
 * Report this entry (#490, §6.3) asks for a clause and takes a note of up to
 * 500 code points, and shows only where there's a steward to send it to.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { ShelfEntry as Entry } from '../shelf/fold';
import { axeViolations } from '../test/axe';
import { ShelfEntry } from './ShelfEntry';

const ADDRESS = 'A'.repeat(43);
const ENTRY: Entry = {
  address: ADDRESS,
  id: 'B'.repeat(43),
  title: 'Rent strike vote',
  text: 'Thursday.',
  name: 'Oak St Tenants',
  seq: 2,
  received: 29_000_000,
  early: false,
  listedSince: 29_000_000,
};

const words = messages.shelfEntry;

/** The page for `entry`, with or without a group that may propose reconciling. */
function setup(entry: Entry | null, mayReconcile: boolean) {
  render(
    <ShelfEntry
      entry={entry}
      link={`https://app.test/#/discover/${ADDRESS}/${ENTRY.id}`}
      copyText={() => Promise.resolve()}
      mayReconcile={mayReconcile}
    />,
  );
}

describe('ShelfEntry: Ask to join and Propose reconciling (#432)', () => {
  it('offers Ask to join, which opens the listing’s door, and passes axe', async () => {
    setup(ENTRY, false);
    expect(screen.getByRole('link', { name: words.askToJoin })).toHaveAttribute(
      'href',
      `#door/${ADDRESS}`,
    );
    expect(screen.queryByRole('link', { name: words.proposeReconciling })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers Propose reconciling, to the same door, to a device with a group that may', async () => {
    setup(ENTRY, true);
    expect(screen.getByRole('link', { name: words.proposeReconciling })).toHaveAttribute(
      'href',
      `#door/${ADDRESS}`,
    );
    expect(screen.getByRole('link', { name: words.askToJoin })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers neither while the shelf doesn’t show the entry', () => {
    setup(null, true);
    expect(screen.queryByRole('link', { name: words.askToJoin })).toBeNull();
    expect(screen.queryByRole('link', { name: words.proposeReconciling })).toBeNull();
  });
});

describe('ShelfEntry: Report this entry (#490)', () => {
  /** The page with Report wired to `onReport`. */
  function withReport(onReport: (clause: string, note: string) => Promise<'sent' | 'failed'>) {
    render(
      <ShelfEntry
        entry={ENTRY}
        link="https://app.test/"
        copyText={() => Promise.resolve()}
        mayReconcile={false}
        onReport={onReport}
      />,
    );
  }

  it('shows no Report without a steward to send it to', () => {
    setup(ENTRY, false);
    expect(screen.queryByRole('button', { name: words.report })).toBeNull();
  });

  it('asks for a clause, takes a note, sends it and says so, passing axe', async () => {
    const user = userEvent.setup();
    const onReport = vi.fn(() => Promise.resolve('sent' as const));
    withReport(onReport);

    await user.click(screen.getByRole('button', { name: words.report }));
    const dialog = await screen.findByRole('dialog', { name: words.reportTitle });
    expect(dialog).toHaveTextContent(words.reportLede);
    expect(await axeViolations()).toEqual([]);
    await user.click(within(dialog).getByRole('radio', { name: /^C3:/ }));
    await user.click(within(dialog).getByRole('textbox', { name: words.noteLabel }));
    await user.paste('Not the real union');
    await user.click(within(dialog).getByRole('button', { name: words.send }));

    expect(await screen.findByText(words.reportSent)).toBeVisible();
    expect(onReport).toHaveBeenCalledWith('C3', 'Not the real union');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refuses a note past 500 characters, and keeps the dialog open when sending fails', async () => {
    const user = userEvent.setup();
    const onReport = vi.fn(() => Promise.resolve('failed' as const));
    withReport(onReport);

    await user.click(screen.getByRole('button', { name: words.report }));
    const dialog = await screen.findByRole('dialog', { name: words.reportTitle });
    await user.click(within(dialog).getByRole('textbox', { name: words.noteLabel }));
    await user.paste('é'.repeat(501));
    await user.click(within(dialog).getByRole('button', { name: words.send }));
    expect(onReport).not.toHaveBeenCalled();
    expect(within(dialog).getByText(words.noteTooLong(500))).toBeVisible();

    await user.clear(within(dialog).getByRole('textbox', { name: words.noteLabel }));
    await user.click(within(dialog).getByRole('button', { name: words.send }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(words.sendFailed);
    expect(onReport).toHaveBeenCalledWith('C2', '');

    await user.click(within(dialog).getByRole('button', { name: words.cancel }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(words.reportSent)).toBeNull();
  });
});
