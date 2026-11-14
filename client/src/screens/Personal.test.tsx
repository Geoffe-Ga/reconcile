/**
 * Personal (#93, `#/me`): this device's personal Documents, one list with
 * New document, or, with none yet, My mission statement offered with its
 * prompt line.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { messages } from '../app/messages';
import { SHARE_TTL_DAYS } from '../share/shareLink';
import type { PersonalDocument } from '../store/personal';
import { axeViolations } from '../test/axe';
import { Personal } from './Personal';

const NEW_ID = 'TmV3IGRvY3VtZW50IGlkIQ';

/** The latest relay minute the device has heard, as Personal reads it (#347). */
const RELAY_NOW = 29_377_500;
/** A day in relay minutes. */
const DAY = 1440;

const DOCUMENTS: PersonalDocument[] = [
  {
    id: 'Q2FuYXJ5IHN0YXRlbWVudA',
    title: 'My mission statement',
    text: 'I show up for my neighbors.\n',
    createdAt: 1,
    updatedAt: 9,
  },
  {
    id: 'UmVhZGluZyBsaXN0IGlkIQ',
    title: 'ليست القراءة',
    text: '',
    createdAt: 2,
    updatedAt: 3,
  },
];

describe('Personal', () => {
  it('offers My mission statement with its one prompt line when there are none yet', async () => {
    render(<Personal documents={[]} newId={NEW_ID} relayNow={RELAY_NOW} relayBackup={false} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Personal' })).toBe(
      document.activeElement,
    );
    expect(document.title).toBe('Personal · Reconcile');
    const offer = screen.getByRole('link', { name: /My mission statement/ });
    expect(offer).toHaveAttribute('href', `#/me/${NEW_ID}`);
    expect(offer).toHaveTextContent('What do you stand for, and what are you working toward?');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New document' })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('lists each Document by its title, in the order given, each opening at #/me/{id}', async () => {
    render(
      <Personal documents={DOCUMENTS} newId={NEW_ID} relayNow={RELAY_NOW} relayBackup={false} />,
    );

    const items = within(screen.getByRole('list')).getAllByRole('link');
    expect(items.map((item) => item.getAttribute('href'))).toEqual([
      '#/me/Q2FuYXJ5IHN0YXRlbWVudA',
      '#/me/UmVhZGluZyBsaXN0IGlkIQ',
    ]);
    expect(items.map((item) => item.querySelector('bdi')?.textContent)).toEqual([
      'My mission statement',
      'ليست القراءة',
    ]);
    expect(screen.queryByText(/What do you stand for/)).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('adds another with New document, at a new id', () => {
    render(
      <Personal documents={DOCUMENTS} newId={NEW_ID} relayNow={RELAY_NOW} relayBackup={false} />,
    );

    expect(screen.getByRole('link', { name: 'New document' })).toHaveAttribute(
      'href',
      `#/me/${NEW_ID}`,
    );
  });

  it('says nobody votes on them, and what stays on this device, and links back to Start', () => {
    render(
      <Personal documents={DOCUMENTS} newId={NEW_ID} relayNow={RELAY_NOW} relayBackup={false} />,
    );

    expect(
      screen.getByText(
        'Documents of your own. Nobody votes on them: you change them whenever you like.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'They stay on this device. Nothing here is sent to the relay or to your groups, unless you share one by link or send one with a request to join. A backup file you save includes them.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: /Your groups/ })).toHaveAttribute('href', '#/');
  });

  it('reaches Settings from a quiet link at its end, as the tab bar’s Me (#423)', async () => {
    render(
      <Personal documents={DOCUMENTS} newId={NEW_ID} relayNow={RELAY_NOW} relayBackup={false} />,
    );

    const settings = screen.getByRole('link', { name: 'Settings' });
    expect(settings).toHaveAttribute('href', '#/settings');
    expect(settings).toHaveClass('forward-link');
    expect(await axeViolations()).toEqual([]);
  });

  it('says the sealed relay backup has them too once the device keeps one, and nothing until it knows (#248)', async () => {
    const { privacy, privacyRelayBackup } = messages.personal;
    const { rerender } = render(
      <Personal documents={DOCUMENTS} newId={NEW_ID} relayNow={RELAY_NOW} relayBackup={true} />,
    );

    expect(
      screen.getByText(
        'They stay on this device. Nothing here goes to your groups. A backup file you save includes them, and so does your sealed relay backup.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(privacy)).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    rerender(
      <Personal documents={DOCUMENTS} newId={NEW_ID} relayNow={RELAY_NOW} relayBackup={false} />,
    );
    expect(screen.getByText(privacy)).toBeVisible();
    expect(screen.queryByText(privacyRelayBackup)).not.toBeInTheDocument();

    // A wrong line is worse than none: until the device has said, there is none.
    rerender(
      <Personal documents={DOCUMENTS} newId={NEW_ID} relayNow={RELAY_NOW} relayBackup={null} />,
    );
    expect(screen.queryByText(privacy)).not.toBeInTheDocument();
    expect(screen.queryByText(privacyRelayBackup)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New document' })).toBeVisible();
  });

  it('marks a Document shared by link under its title, and no other (#105)', async () => {
    const [first, second] = DOCUMENTS;
    if (first === undefined || second === undefined) throw new Error('Expected two Documents.');
    const share = {
      seed: new Uint8Array(32),
      secretKey: new Uint8Array(32),
      publicKey: new Uint8Array(32),
      n: 1,
      postedAt: RELAY_NOW - 1,
      pending: false,
    };
    render(
      <Personal
        documents={[first, { ...second, share }]}
        newId={NEW_ID}
        relayNow={RELAY_NOW}
        relayBackup={false}
      />,
    );

    const [plain, shared] = within(screen.getByRole('list')).getAllByRole('link');
    expect(plain).not.toHaveTextContent('Shared by link');
    expect(shared).toHaveTextContent('ليست القراءة');
    expect(shared).toHaveTextContent('Shared by link');
    expect(await axeViolations()).toEqual([]);
  });

  it('marks a Document whose share a restore paused, so the person knows to open it (#328)', async () => {
    const [first, second] = DOCUMENTS;
    if (first === undefined || second === undefined) throw new Error('Expected two Documents.');
    const share = {
      seed: new Uint8Array(32),
      secretKey: new Uint8Array(32),
      publicKey: new Uint8Array(32),
      n: 1,
      postedAt: RELAY_NOW - 1,
      pending: false,
    };
    render(
      <Personal
        documents={[
          { ...first, share: { ...share, paused: true } },
          { ...second, share },
        ]}
        newId={NEW_ID}
        relayNow={RELAY_NOW}
        relayBackup={false}
      />,
    );

    const [paused, shared] = within(screen.getByRole('list')).getAllByRole('link');
    expect(paused).toHaveTextContent('My mission statement');
    expect(paused).toHaveTextContent('Link paused after a restore');
    expect(paused).not.toHaveTextContent('Shared by link');
    expect(shared).toHaveTextContent('Shared by link');
    expect(await axeViolations()).toEqual([]);
  });

  it('marks a Document whose share this device hasn’t posted to for 30 days on the relay’s clock, so the person knows to open it (#339, #347)', async () => {
    const [first, second] = DOCUMENTS;
    if (first === undefined || second === undefined) throw new Error('Expected two Documents.');
    const share = {
      seed: new Uint8Array(32),
      secretKey: new Uint8Array(32),
      publicKey: new Uint8Array(32),
      n: 1,
      postedAt: RELAY_NOW - SHARE_TTL_DAYS * DAY,
      pending: false,
    };
    render(
      <Personal
        documents={[
          { ...first, share },
          { ...second, share: { ...share, postedAt: share.postedAt + 1 } },
        ]}
        newId={NEW_ID}
        relayNow={RELAY_NOW}
        relayBackup={false}
      />,
    );

    const [idle, shared] = within(screen.getByRole('list')).getAllByRole('link');
    expect(idle).toHaveTextContent('My mission statement');
    expect(idle).toHaveTextContent('Link paused after 30 days without an update');
    expect(idle).not.toHaveTextContent('Shared by link');
    expect(shared).toHaveTextContent('Shared by link');
    expect(shared).not.toHaveTextContent('Link paused');
    expect(await axeViolations()).toEqual([]);
  });

  it('marks a share idle by its own last read with no relay minute heard, and none idle with nothing to measure by (#347)', () => {
    const [first, second] = DOCUMENTS;
    if (first === undefined || second === undefined) throw new Error('Expected two Documents.');
    const share = {
      seed: new Uint8Array(32),
      secretKey: new Uint8Array(32),
      publicKey: new Uint8Array(32),
      n: 1,
      postedAt: RELAY_NOW,
      pending: false,
    };
    render(
      <Personal
        documents={[
          { ...first, share: { ...share, seenAt: RELAY_NOW + SHARE_TTL_DAYS * DAY } },
          { ...second, share },
        ]}
        newId={NEW_ID}
        relayNow={null}
        relayBackup={false}
      />,
    );

    const [idle, shared] = within(screen.getByRole('list')).getAllByRole('link');
    expect(idle).toHaveTextContent('Link paused after 30 days without an update');
    expect(shared).toHaveTextContent('Shared by link');
  });
});
