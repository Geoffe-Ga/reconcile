/**
 * The two-tap passkey setup (#95): Make a passkey, then Confirm your
 * passkey, one WebAuthn call each, then one plain line on how it ended.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { messages } from './messages';
import type { Protection } from './passkey';
import { PasskeySetup, type PasskeySetupProps } from './PasskeySetup';

const ID = Uint8Array.of(4, 5, 6);

/** A promise and the ways to settle it, so a test can hold a tap in flight. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(props: Partial<PasskeySetupProps> = {}) {
  const all: PasskeySetupProps = {
    onCreate: vi.fn(() => Promise.resolve(ID)),
    onProtect: vi.fn(() => Promise.resolve<Protection>('protected')),
    onEnd: vi.fn(),
    linkBackup: false,
    ...props,
  };
  document.title = 'Settings · Reconcile';
  render(
    <main>
      <h1>Settings</h1>
      <PasskeySetup {...all} />
    </main>,
  );
  return { user: userEvent.setup(), ...all };
}

const { passkey } = messages;

describe('PasskeySetup', () => {
  it('starts with one primary button, Make a passkey, and passes axe', async () => {
    setup();

    const make = screen.getByRole('button', { name: passkey.create });
    expect(make).toHaveClass('button-primary');
    expect(screen.getAllByRole('button')).toEqual([make]);
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(await axeViolations()).toEqual([]);
  });

  it('makes the passkey on tap 1, then asks for tap 2 on the same button, keeping focus', async () => {
    const made = deferred<Uint8Array>();
    const { user, onCreate, onProtect } = setup({ onCreate: vi.fn(() => made.promise) });

    await user.click(screen.getByRole('button', { name: passkey.create }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(passkey.creating);
    expect(screen.getByRole('button', { name: passkey.create })).toBeDisabled();
    await act(async () => {
      made.resolve(ID);
      await made.promise;
    });
    const confirm = screen.getByRole('button', { name: passkey.confirm });
    expect(confirm).toHaveFocus();
    expect(screen.getByText(passkey.confirmLede)).toBeVisible();
    expect(onProtect).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('locks the keys on tap 2 with the passkey tap 1 made, and says so', async () => {
    const { user, onProtect, onEnd } = setup();

    await user.click(screen.getByRole('button', { name: passkey.create }));
    await user.click(await screen.findByRole('button', { name: passkey.confirm }));

    expect(onProtect).toHaveBeenCalledWith(ID);
    const line = await screen.findByText(passkey.locked);
    expect(line).toHaveFocus();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(onEnd).toHaveBeenCalledWith('protected');
    expect(await axeViolations()).toEqual([]);
  });

  it('says plainly when the passkey can’t protect the keys, linking to Save a backup where asked', async () => {
    const { user, onEnd } = setup({
      onProtect: vi.fn(() => Promise.resolve<Protection>('no-prf')),
      linkBackup: true,
    });

    await user.click(screen.getByRole('button', { name: passkey.create }));
    await user.click(await screen.findByRole('button', { name: passkey.confirm }));

    expect(await screen.findByText(passkey.noPrf)).toHaveFocus();
    expect(screen.getByRole('link', { name: passkey.saveBackup })).toHaveAttribute(
      'href',
      '#/settings',
    );
    expect(onEnd).toHaveBeenCalledWith('no-prf');
    expect(await axeViolations()).toEqual([]);
  });

  it('links nowhere from the no-PRF line in Settings, which holds Save a backup itself', async () => {
    const { user } = setup({ onProtect: vi.fn(() => Promise.resolve<Protection>('no-prf')) });

    await user.click(screen.getByRole('button', { name: passkey.create }));
    await user.click(await screen.findByRole('button', { name: passkey.confirm }));

    expect(await screen.findByText(passkey.noPrf)).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('says no passkey was made when tap 1 fails, and lets it be tried again', async () => {
    const onCreate = vi
      .fn<() => Promise<Uint8Array>>()
      .mockRejectedValueOnce(new Error('cancelled'))
      .mockResolvedValueOnce(ID);
    const { user, onEnd } = setup({ onCreate });

    await user.click(screen.getByRole('button', { name: passkey.create }));

    expect(await screen.findByRole('alert')).toHaveTextContent(passkey.createFailed);
    expect(onEnd).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: passkey.create }));
    expect(await screen.findByRole('button', { name: passkey.confirm })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('asks again for the same passkey when tap 2 doesn’t answer, deciding nothing', async () => {
    const onProtect = vi
      .fn<(id: Uint8Array) => Promise<Protection>>()
      .mockRejectedValueOnce(new Error('cancelled'))
      .mockResolvedValueOnce('protected');
    const { user, onEnd } = setup({ onProtect });

    await user.click(screen.getByRole('button', { name: passkey.create }));
    await user.click(await screen.findByRole('button', { name: passkey.confirm }));

    expect(await screen.findByRole('alert')).toHaveTextContent(passkey.confirmFailed);
    expect(onEnd).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: passkey.confirm }));
    expect(onProtect).toHaveBeenNthCalledWith(2, ID);
    expect(await screen.findByText(passkey.locked)).toBeVisible();
  });

  it('sends one request per tap, however fast the taps come', async () => {
    const made = deferred<Uint8Array>();
    const { user, onCreate } = setup({ onCreate: vi.fn(() => made.promise) });
    const make = screen.getByRole('button', { name: passkey.create });

    await user.click(make);
    await user.click(make);

    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
