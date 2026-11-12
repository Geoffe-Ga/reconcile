/**
 * Personal (#93, `#/me`): this device's personal Documents, one list with
 * New document, or, with none yet, My mission statement offered with its
 * prompt line.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { messages } from '../app/messages';
import type { PersonalDocument } from '../store/personal';
import { axeViolations } from '../test/axe';
import { Personal } from './Personal';

const NEW_ID = 'TmV3IGRvY3VtZW50IGlkIQ';

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
    render(<Personal documents={[]} newId={NEW_ID} relayBackup={false} />);

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
    render(<Personal documents={DOCUMENTS} newId={NEW_ID} relayBackup={false} />);

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
    render(<Personal documents={DOCUMENTS} newId={NEW_ID} relayBackup={false} />);

    expect(screen.getByRole('link', { name: 'New document' })).toHaveAttribute(
      'href',
      `#/me/${NEW_ID}`,
    );
  });

  it('says nobody votes on them, and what stays on this device, and links back to Start', () => {
    render(<Personal documents={DOCUMENTS} newId={NEW_ID} relayBackup={false} />);

    expect(
      screen.getByText(
        'Documents of your own. Nobody votes on them: you change them whenever you like.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'They stay on this device. Nothing here is sent to the relay or to your groups, unless you share one by link. A backup file you save includes them.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: /Your groups/ })).toHaveAttribute('href', '#/');
  });

  it('says the sealed relay backup has them too once the device keeps one, and nothing until it knows (#248)', async () => {
    const { privacy, privacyRelayBackup } = messages.personal;
    const { rerender } = render(
      <Personal documents={DOCUMENTS} newId={NEW_ID} relayBackup={true} />,
    );

    expect(
      screen.getByText(
        'They stay on this device. Nothing here goes to your groups. A backup file you save includes them, and so does your sealed relay backup.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(privacy)).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    rerender(<Personal documents={DOCUMENTS} newId={NEW_ID} relayBackup={false} />);
    expect(screen.getByText(privacy)).toBeVisible();
    expect(screen.queryByText(privacyRelayBackup)).not.toBeInTheDocument();

    // A wrong line is worse than none: until the device has said, there is none.
    rerender(<Personal documents={DOCUMENTS} newId={NEW_ID} relayBackup={null} />);
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
      lastPostedAt: 1,
      pending: false,
    };
    render(
      <Personal documents={[first, { ...second, share }]} newId={NEW_ID} relayBackup={false} />,
    );

    const [plain, shared] = within(screen.getByRole('list')).getAllByRole('link');
    expect(plain).not.toHaveTextContent('Shared by link');
    expect(shared).toHaveTextContent('ليست القراءة');
    expect(shared).toHaveTextContent('Shared by link');
    expect(await axeViolations()).toEqual([]);
  });
});
