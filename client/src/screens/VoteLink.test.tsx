/**
 * A vote link's screen (#472, ADR-0079 §3): it looks for the Proposal the
 * token names on this device, and opens it; with no match, it waits for the
 * sync pass under way and looks once more, and only then says the vote isn't
 * on this device, in one line that never varies with the token.
 */
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { VoteTarget } from '../app/voteLink';
import { axeViolations } from '../test/axe';
import { VoteLink } from './VoteLink';

const TARGET: VoteTarget = { groupId: 'g1', proposalId: 'p1' };

/** A promise and the way to settle it, so a test says when a sync pass ends. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('VoteLink (#472)', () => {
  it('opens the Proposal at once when the device holds it, and never waits for a sync', async () => {
    const onFound = vi.fn();
    const waitForSync = vi.fn(() => Promise.resolve());

    render(
      <VoteLink
        locate={() => Promise.resolve(TARGET)}
        waitForSync={waitForSync}
        onFound={onFound}
      />,
    );

    await vi.waitFor(() => {
      expect(onFound).toHaveBeenCalledWith(TARGET);
    });
    expect(waitForSync).not.toHaveBeenCalled();
    expect(screen.queryByText(messages.vote.missing)).toBeNull();
  });

  it('shows the no-match line only after the sync pass, and only when that pass brought nothing', async () => {
    const onFound = vi.fn();
    const pass = deferred<undefined>();
    const locate = vi.fn(() => Promise.resolve(null));

    render(<VoteLink locate={locate} waitForSync={() => pass.promise} onFound={onFound} />);

    expect(await screen.findByRole('status')).toHaveTextContent(messages.vote.looking);
    await vi.waitFor(() => {
      expect(locate).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(messages.vote.missing)).toBeNull();

    await act(async () => {
      pass.resolve(undefined);
      await pass.promise;
    });

    expect(await screen.findByText(messages.vote.missing)).toBeInTheDocument();
    expect(locate).toHaveBeenCalledTimes(2);
    expect(onFound).not.toHaveBeenCalled();
  });

  it('opens the Proposal the sync pass brought', async () => {
    const onFound = vi.fn();
    const locate = vi
      .fn<() => Promise<VoteTarget | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(TARGET);

    render(<VoteLink locate={locate} waitForSync={() => Promise.resolve()} onFound={onFound} />);

    await vi.waitFor(() => {
      expect(onFound).toHaveBeenCalledWith(TARGET);
    });
    expect(screen.queryByText(messages.vote.missing)).toBeNull();
  });

  it('says the vote isn’t on this device even when the sync pass fails', async () => {
    render(
      <VoteLink
        locate={() => Promise.resolve(null)}
        waitForSync={() => Promise.reject(new Error('offline'))}
        onFound={vi.fn()}
      />,
    );

    expect(await screen.findByText(messages.vote.missing)).toBeInTheDocument();
  });

  it('reads the same words for every token: the line names no group and says nothing of the token', async () => {
    expect(messages.vote.missing).toBe(
      'This vote isn’t on this device. It opens only on a device that’s in the vote’s group.',
    );
    render(
      <VoteLink
        locate={() => Promise.resolve(null)}
        waitForSync={() => Promise.resolve()}
        onFound={vi.fn()}
      />,
    );
    await screen.findByText(messages.vote.missing);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(messages.vote.title);
    // Not a dead end: the way back to Your groups.
    expect(screen.getByRole('link', { name: /Your groups/ })).toHaveAttribute('href', '#/');
    expect(document.title).toContain(messages.vote.pageTitle);
    expect(await axeViolations()).toEqual([]);
  });

  it('does nothing once it has gone, however late an answer comes', async () => {
    const onFound = vi.fn();
    const answer = deferred<VoteTarget | null>();

    const { unmount } = render(
      <VoteLink
        locate={() => answer.promise}
        waitForSync={() => Promise.resolve()}
        onFound={onFound}
      />,
    );
    unmount();
    await act(async () => {
      answer.resolve(TARGET);
      await answer.promise;
    });

    expect(onFound).not.toHaveBeenCalled();
  });
});
