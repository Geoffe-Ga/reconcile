/**
 * Share beside a link that is made at the press (#424; ADR-0077 §6): Share a
 * follow link on a coalition's home. A link still being made goes to the
 * share sheet once it's ready, from the same press; with no share sheet, Share
 * copies it as the copy path does, its clipboard write started at the press.
 * A link already on show is shared at once, with no new one made.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { messages } from './messages';
import type { WebShare } from './share';
import { ShareLink, type ShareLinkProps } from './ShareLink';

const LINK = 'https://reconcile.test/#follow/abc';
const { coalitions } = messages;
const WORDS = {
  warning: coalitions.shareWarning,
  button: coalitions.copyFollowLink,
  field: coalitions.shareField,
  making: coalitions.sharing,
  failed: coalitions.shareFailed,
  copied: coalitions.shareCopied,
  copyFailed: messages.home.copyFailed,
};

/** A link the test makes ready when it chooses. */
function deferredLink() {
  let ready: (link: string) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const made = new Promise<string>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  return { made, ready, fail };
}

function renderShareLink(overrides: Partial<ShareLinkProps> = {}) {
  const props: ShareLinkProps = {
    words: WORDS,
    makeLink: vi.fn(() => Promise.resolve(LINK)),
    copyText: vi.fn((text: string | Promise<string>) =>
      Promise.resolve(text).then(() => undefined),
    ),
    primary: false,
    ...overrides,
  };
  document.title = 'Reconcile';
  render(
    <main>
      <h1>{coalitions.followers}</h1>
      <ShareLink {...props} />
    </main>,
  );
  return props;
}

const shareButton = () => screen.getByRole('button', { name: messages.linkShare.button });
const copyButton = () => screen.getByRole('button', { name: coalitions.copyFollowLink });

/** Lets every pending promise and the renders they cause finish. */
const settle = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

describe('ShareLink’s Share (#424)', () => {
  it('isn’t there when the screen gives no share port, as for an invite link', () => {
    renderShareLink();
    expect(copyButton()).toBeVisible();
    expect(
      screen.queryByRole('button', { name: messages.linkShare.button }),
    ).not.toBeInTheDocument();
  });

  it('sits beside the button, secondary, with the warning and who else can read the link', async () => {
    renderShareLink({ sharing: { share: vi.fn<WebShare>(() => Promise.resolve()) } });
    expect(shareButton()).toHaveClass('button-secondary');
    expect(shareButton()).toHaveAccessibleDescription(
      `${coalitions.shareWarning} ${messages.linkShare.chatNote}`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('makes a link and shares exactly it once it’s ready, from the one press', async () => {
    const user = userEvent.setup();
    const { made, ready } = deferredLink();
    const makeLink = vi.fn(() => made);
    const share = vi.fn<WebShare>(() => Promise.resolve());
    const { copyText } = renderShareLink({ makeLink, sharing: { share } });

    await user.click(shareButton());
    expect(makeLink).toHaveBeenCalledOnce();
    expect(share).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(coalitions.sharing);

    ready(LINK);
    await settle();
    expect(share.mock.calls).toEqual([[{ url: LINK }]]);
    expect(copyText).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: coalitions.shareField })).toHaveValue(LINK);
    expect(screen.getByRole('status')).toHaveTextContent(messages.linkShare.shared);
    expect(await axeViolations()).toEqual([]);
  });

  it('without Web Share, copies as the copy path does: the write starts at the press', async () => {
    const user = userEvent.setup();
    const { made, ready } = deferredLink();
    const copyText = vi.fn((text: string | Promise<string>) =>
      Promise.resolve(text).then(() => undefined),
    );
    renderShareLink({ makeLink: () => made, copyText, sharing: { share: undefined } });

    await user.click(shareButton());
    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText.mock.calls[0]?.[0]).toBe(made);

    ready(LINK);
    expect(await screen.findByText(coalitions.shareCopied)).toBeVisible();
    expect(screen.getByRole('textbox', { name: coalitions.shareField })).toHaveValue(LINK);
  });

  it('shares the link on show at once, making no other', async () => {
    const user = userEvent.setup();
    const makeLink = vi.fn(() => Promise.resolve(LINK));
    const share = vi.fn<WebShare>(() => Promise.resolve());
    renderShareLink({ makeLink, sharing: { share } });

    await user.click(copyButton());
    expect(await screen.findByText(coalitions.shareCopied)).toBeVisible();
    await user.click(shareButton());

    expect(makeLink).toHaveBeenCalledOnce();
    expect(share.mock.calls).toEqual([[{ url: LINK }]]);
    expect(await screen.findByText(messages.linkShare.shared)).toBeVisible();
  });

  it('announces nothing, and copies nothing, when the share sheet is closed', async () => {
    const user = userEvent.setup();
    const share = vi.fn<WebShare>(() =>
      Promise.reject(new DOMException('Share canceled', 'AbortError')),
    );
    const { copyText } = renderShareLink({ sharing: { share } });

    await user.click(shareButton());
    await settle();

    expect(share).toHaveBeenCalledOnce();
    expect(copyText).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.getByRole('textbox', { name: coalitions.shareField })).toHaveValue(LINK);
  });

  it('copies the link when Web Share refuses it, and says so', async () => {
    const user = userEvent.setup();
    const share = vi.fn<WebShare>(() =>
      Promise.reject(new DOMException('No tap', 'NotAllowedError')),
    );
    const { copyText } = renderShareLink({ sharing: { share } });

    await user.click(shareButton());

    expect(await screen.findByText(coalitions.shareCopied)).toBeVisible();
    expect(copyText).toHaveBeenCalledWith(LINK);
  });

  it('says so when the link couldn’t be made, and shares nothing', async () => {
    const user = userEvent.setup();
    const { made, fail } = deferredLink();
    const share = vi.fn<WebShare>(() => Promise.resolve());
    renderShareLink({ makeLink: () => made, sharing: { share } });

    await user.click(shareButton());
    fail(new Error('offline'));

    expect(await screen.findByText(coalitions.shareFailed)).toBeVisible();
    expect(share).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: coalitions.shareField })).not.toBeInTheDocument();
  });

  it('makes one link at a time, whichever button is pressed', async () => {
    const user = userEvent.setup();
    const { made, ready } = deferredLink();
    const makeLink = vi.fn(() => made);
    const share = vi.fn<WebShare>(() => Promise.resolve());
    renderShareLink({ makeLink, sharing: { share } });

    await user.click(shareButton());
    await user.click(shareButton());
    await user.click(copyButton());
    expect(makeLink).toHaveBeenCalledOnce();

    ready(LINK);
    await settle();
    expect(share).toHaveBeenCalledOnce();
  });
});
