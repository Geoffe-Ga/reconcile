/**
 * What `main.tsx` renders when a share link opens a fresh page (#105): the
 * shared page alone, on the relay and the seal, with no store, sync or first
 * run behind it, until the address leaves the link.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { xchachaSeal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import { createFakeRelay } from '../test/fakeRelay';
import { messages } from './messages';
import { SharedRoot } from './SharedRoot';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

function renderShared() {
  const fake = createFakeRelay();
  const reload = vi.fn();
  const reader = { relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal };
  render(<SharedRoot reader={reader} reload={reload} />);
  return { reload };
}

describe('SharedRoot', () => {
  it('shows the shared page for the link in the address bar', async () => {
    window.history.replaceState(null, '', '/#share/damaged');
    const { reload } = renderShared();

    expect(await screen.findByText(messages.shared.gone)).toBeVisible();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads into the whole app once the address leaves the link', async () => {
    window.history.replaceState(null, '', '/#share/damaged');
    const { reload } = renderShared();
    await screen.findByText(messages.shared.gone);

    act(() => {
      window.history.pushState(null, '', '/#/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(messages.shared.gone)).not.toBeInTheDocument();
  });
});
