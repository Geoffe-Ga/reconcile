/**
 * Reconcile cards in the app (#114): Reconcile with another group's form and
 * link, Bring a card's expired, used and found screens, and what the relay
 * sees of it all: no coalition secret, `inner`, seat secret or seed outside
 * `#`, in any request, in any spelling.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { newCardSeed } from '../crypto/card';
import { fold } from '../engine/fold';
import { type TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import {
  anaMakesCard,
  closeAll,
  coalitionOn,
  open,
  SLOW,
  syncAll,
  twoGroups,
  vote,
} from '../test/coalitionDevices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { type Canary, findCanaries, keyCanaries, textCanary } from '../test/scan';
import { App } from './App';
import { messages } from './messages';
import { bringCard } from './reconcile';

freshIndexedDBPerTest();

afterEach(closeAll);

/** Opens `hash` in `device`'s app, as following a link would. */
function opening(device: TestDevice, hash: string): void {
  window.history.replaceState(null, '', hash);
  render(<App services={device.services} />);
}

/** Every byte a request carried: its URL, then its body. */
function sent(fake: FakeRelay): Uint8Array[] {
  return fake.requests.map((request) => {
    const url = new TextEncoder().encode(request.url);
    const body = request.body ?? new Uint8Array();
    const all = new Uint8Array(url.length + body.length);
    all.set(url);
    all.set(body, url.length);
    return all;
  });
}

describe('Reconcile with another group', SLOW, () => {
  it('asks for the coalition, queues the Proposal, then shows the link beside its warning', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { ana, riverside } = await twoGroups(fake);
    opening(ana, `#/g/${riverside}`);
    const coalitions = await screen.findByRole('region', { name: 'Coalitions' });
    await user.click(
      within(coalitions).getByRole('link', { name: /Reconcile with another group/ }),
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Reconcile with another group' }),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Make the card' }));
    expect(
      screen.getByRole('textbox', { name: 'The coalition’s name' }),
    ).toHaveAccessibleDescription(
      'A name of its own, apart from either group’s. Add a name for the coalition.',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'The coalition’s name' }),
      'Eastside Housing',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Its first statement' }),
      'Everyone has a home.',
    );
    await user.type(screen.getByRole('textbox', { name: 'Why' }), 'We share a landlord.');
    const yourName = screen.getByRole('textbox', { name: 'Your name in the coalition' });
    expect(yourName).toHaveAccessibleDescription(
      expect.stringContaining('This name is only shown in this coalition.'),
    );
    await user.type(yourName, 'Ana E.');
    await user.click(screen.getByRole('button', { name: 'Make the card' }));

    const link = await screen.findByRole('textbox', { name: 'Card link' });
    expect(link).toHaveAttribute('readonly');
    expect((link as HTMLInputElement).value).toMatch(
      /^https:\/\/reconcile\.test\/#reconcile\/[A-Za-z0-9_-]{43}$/,
    );
    expect(link).toHaveAccessibleDescription(messages.card.warning);
    expect(screen.getByRole('heading', { level: 1, name: 'Your card is ready' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(ana.copied).toEqual([(link as HTMLInputElement).value]);
    const group = await ana.services.store.getGroup(riverside);
    const proposal = fold(group?.log ?? [], null).proposals.at(-1);
    expect(proposal?.target.kind).toBe('reconcile');
    expect(proposal?.title).toBe('Reconcile into Eastside Housing');
  });

  it('shows no link, and offers Try again, when the relay can’t take the card', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { ana, riverside } = await twoGroups(fake);
    opening(ana, `#/g/${riverside}/reconcile`);
    await user.type(
      await screen.findByRole('textbox', { name: 'The coalition’s name' }),
      'Eastside',
    );
    await user.type(screen.getByRole('textbox', { name: 'Its first statement' }), 'One.');
    await user.type(screen.getByRole('textbox', { name: 'Why' }), 'Why not.');
    await user.type(screen.getByRole('textbox', { name: 'Your name in the coalition' }), 'Ana');
    fake.offline = true;
    await user.click(screen.getByRole('button', { name: 'Make the card' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.card.failed);
    expect(screen.queryByRole('textbox', { name: 'Card link' })).not.toBeInTheDocument();
    fake.offline = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('textbox', { name: 'Card link' })).toBeVisible();
    const group = await ana.services.store.getGroup(riverside);
    const queued = [...(group?.outbox ?? []), ...(group?.log ?? []).map((record) => record.bytes)];
    expect(
      queued.filter((bytes) => new TextDecoder().decode(bytes).includes('"reconcile"')),
    ).toHaveLength(1);
  });
});

describe('Bring a card', SLOW, () => {
  it('shows the expired line for a malformed seed, and makes no request', async () => {
    const fake = createFakeRelay();
    const ben = await open(fake, 'ben');
    opening(ben, `#reconcile/${'A'.repeat(42)}B`);

    expect(await screen.findByText(messages.bring.badLink)).toBeVisible();
    expect(window.location.hash).toBe('#/card');
    expect(fake.requests).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the expired line for an empty card mailbox, after one read of it', async () => {
    const fake = createFakeRelay();
    const ben = await open(fake, 'ben');
    opening(ben, `#reconcile/${base64url(newCardSeed())}`);

    expect(await screen.findByText(messages.bring.badLink)).toBeVisible();
    expect(fake.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('says a card whose coalition is forming has already been used', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await twoGroups(fake);
    const { found, link } = await anaMakesCard(ana, cy, riverside);
    await bringCard(cy.services, found, oak, 'Cy');
    await syncAll(1);
    opening(ben, new URL(link).hash);

    expect(await screen.findByText(messages.bring.used)).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: messages.bring.usedTitle })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Bring to my group' })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the card as plain text, picks a group and brings it there', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { ana, cy, riverside, oak } = await twoGroups(fake);
    const values = {
      name: 'Eastside *Housing*',
      statement: 'Everyone has a <b>home</b>.\n\nWe meet monthly.',
      why: 'We share a landlord.',
      yourName: 'Ana E.',
    };
    const { link } = await anaMakesCard(ana, cy, riverside, values);
    opening(cy, new URL(link).hash);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Eastside *Housing*' }),
    ).toBeVisible();
    expect(window.location.hash).toBe('#/card');
    expect(screen.getByText('Everyone has a <b>home</b>.')).toBeVisible();
    expect(screen.getByText(/^From/)).toHaveTextContent('From Riverside Tenants');
    const picker = screen.getByRole('radiogroup', { name: 'Your group' });
    expect(
      within(picker)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Oak St Co-op']);
    expect(within(picker).getByRole('radio', { name: 'Oak St Co-op' })).toBeChecked();
    expect(await axeViolations()).toEqual([]);
    await user.type(screen.getByRole('textbox', { name: 'Your name in the coalition' }), 'Cy');
    await user.click(screen.getByRole('button', { name: 'Bring to my group' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Reconcile into Eastside *Housing*' }),
    ).toBeVisible();
    expect(window.location.hash).toMatch(new RegExp(`^#/g/${oak}/p/`));
    const statement = screen.getByRole('region', { name: 'The coalition’s statement' });
    expect(statement).toHaveTextContent('Eastside *Housing*');
    await syncAll(1);
    // Once the relay has ordered it, the Proposal shows the coalition's other group.
    const ordered = await screen.findByRole('region', { name: 'The coalition’s statement' });
    expect(await within(ordered).findByText(/Reconcile with/)).toHaveTextContent(
      'Reconcile with Riverside Tenants',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('says when no group on the device can take the card', async () => {
    const fake = createFakeRelay();
    const { ana, cy, riverside } = await twoGroups(fake);
    const { link } = await anaMakesCard(ana, cy, riverside);
    opening(ana, new URL(link).hash);

    expect(await screen.findByText(messages.bring.noGroups)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Bring to my group' })).not.toBeInTheDocument();
  });
});

describe('what the relay sees of a card', SLOW, () => {
  it('finds no coalition secret, inner, seat secret or seed in any request', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await twoGroups(fake);
    const { proposal, found, seed, card } = await anaMakesCard(ana, cy, riverside);
    const brought = await bringCard(cy.services, found, oak, 'Cy');
    await syncAll(1);
    await vote(riverside, proposal, [ana, cy]);
    await vote(oak, brought, [ben, cy]);
    await syncAll();
    expect((await coalitionOn(ben)).coalition?.status).toBe('formed');

    const seats = await seatSecrets([ana, cy], [riverside, oak]);
    expect(seats).toHaveLength(2);
    const canaries: Canary[] = [
      ...keyCanaries('the coalition secret', card.secret),
      ...keyCanaries('inner', card.inner),
      ...keyCanaries('the seed', seed),
      ...seats.flatMap((secret, index) => keyCanaries(`seat secret ${String(index)}`, secret)),
      textCanary('the coalition’s name', 'Eastside Housing'),
      textCanary('the statement', 'Everyone on the east side has a safe home.'),
    ];
    const leaks = sent(fake).flatMap((bytes) => findCanaries(bytes, canaries));
    expect(fake.requests.length).toBeGreaterThan(20);
    expect(leaks).toEqual([]);
    // A positive control: the same scan finds what it looks for in a request that holds it.
    const control = new TextEncoder().encode(`/v1/mailbox/${base64url(card.secret)}`);
    expect(findCanaries(control, canaries)).toContain(
      'the coalition secret (raw), as base64url at offset 0',
    );
  });
});

/** Each group's reconcile seat secret, as `devices[i]` reads `groups[i]`'s own log. */
async function seatSecrets(devices: readonly TestDevice[], groups: readonly string[]) {
  const secrets: Uint8Array[] = [];
  for (const [index, device] of devices.entries()) {
    const group = await device.services.store.getGroup(groups[index] ?? '');
    const state = fold(group?.log ?? [], null);
    for (const p of state.proposals) {
      if (p.target.kind === 'reconcile') secrets.push(fromBase64url(p.target.seat));
    }
  }
  await waitFor(() => {
    expect(secrets.length).toBeGreaterThan(0);
  });
  return secrets;
}
