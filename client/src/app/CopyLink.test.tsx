/**
 * A link with Copy, and with Share beside it where the screen gives a share
 * port (#424; ADR-0077 §6): a reconcile card's link, made or in the
 * Coalitions section. Share hands the device's share sheet the link alone,
 * copies it where there's no sheet, and says nothing when the sheet is closed.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { CopyLink, type CopyLinkProps } from './CopyLink';
import { messages } from './messages';
import type { WebShare } from './share';

const LINK = 'https://reconcile.test/#reconcile/abc';

function renderLink(overrides: Partial<CopyLinkProps> = {}) {
  const props: CopyLinkProps = {
    link: LINK,
    label: messages.card.linkLabel,
    hint: messages.card.warning,
    button: messages.card.copy,
    primary: true,
    copyText: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  document.title = 'Reconcile';
  render(
    <main>
      <h1>{messages.card.madeTitle}</h1>
      <CopyLink {...props} />
    </main>,
  );
  return props;
}

const shareButton = () => screen.getByRole('button', { name: messages.linkShare.button });

/** Lets every pending promise and the renders they cause finish. */
const settle = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

describe('CopyLink', () => {
  it('shows Copy alone when the screen gives no share port', async () => {
    const user = userEvent.setup();
    const { copyText } = renderLink();
    expect(
      screen.queryByRole('button', { name: messages.linkShare.button }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(messages.linkShare.chatNote)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: messages.card.copy }));
    expect(copyText).toHaveBeenCalledWith(LINK);
    expect(screen.getByRole('status')).toHaveTextContent(messages.install.copied);
  });

  it('puts Share beside Copy, secondary, with the line on who else can read the link', async () => {
    renderLink({ sharing: { share: vi.fn<WebShare>(() => Promise.resolve()) } });
    expect(shareButton()).toHaveClass('button-secondary');
    expect(shareButton()).toHaveAccessibleDescription(messages.linkShare.chatNote);
    expect(screen.getByText(messages.linkShare.chatNote)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('with a share port, passes it exactly the link, and says it was shared', async () => {
    const user = userEvent.setup();
    const share = vi.fn<WebShare>(() => Promise.resolve());
    const { copyText } = renderLink({ sharing: { share } });

    await user.click(shareButton());

    expect(share.mock.calls).toEqual([[{ url: LINK }]]);
    expect(copyText).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(messages.linkShare.shared);
  });

  it('without one, copies the link and says so', async () => {
    const user = userEvent.setup();
    const { copyText } = renderLink({ sharing: { share: undefined } });

    await user.click(shareButton());

    expect(copyText).toHaveBeenCalledWith(LINK);
    expect(await screen.findByText(messages.install.copied)).toBeVisible();
  });

  it('says so when there’s no share sheet and copying is blocked too', async () => {
    const user = userEvent.setup();
    const copyText = vi.fn(() => Promise.reject(new Error('blocked')));
    renderLink({ sharing: { share: undefined }, copyText });
    await user.click(shareButton());
    expect(await screen.findByText(messages.home.copyFailed)).toBeVisible();
  });

  it('announces nothing, and copies nothing, when the share sheet is closed', async () => {
    const user = userEvent.setup();
    const share = vi.fn<WebShare>(() =>
      Promise.reject(new DOMException('Share canceled', 'AbortError')),
    );
    const { copyText } = renderLink({ sharing: { share } });

    await user.click(shareButton());
    await settle();

    expect(share).toHaveBeenCalledOnce();
    expect(copyText).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('opens one share sheet at a time', async () => {
    const user = userEvent.setup();
    let close: () => void = () => undefined;
    const share = vi.fn<WebShare>(
      () =>
        new Promise<void>((resolve) => {
          close = resolve;
        }),
    );
    const { copyText } = renderLink({ sharing: { share } });

    await user.click(shareButton());
    await user.click(shareButton());
    expect(share).toHaveBeenCalledOnce();
    expect(copyText).not.toHaveBeenCalled();

    close();
    expect(await screen.findByText(messages.linkShare.shared)).toBeVisible();
    await user.click(shareButton());
    expect(share).toHaveBeenCalledTimes(2);
  });
});
