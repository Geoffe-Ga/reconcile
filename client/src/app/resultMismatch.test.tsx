/**
 * A forged result (#114; ADR-0075 §1): someone who holds Riverside's seat
 * secret, on a test store bound to Riverside's seat, reports a pass for it on
 * the genesis while Riverside's own vote failed. Riverside's members see the
 * result doesn't match their vote, and the coalition counts the contested
 * seat as a fail.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { signSeatProof } from '../crypto/seat';
import { publicKeyOf } from '../crypto/sign';
import { signEvent } from '../engine/event';
import { fold } from '../engine/fold';
import type { TestDevice } from '../test/appServices';
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
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { newEntry } from '../store/coalitions';
import { App } from './App';
import { messages } from './messages';
import { bringCard } from './reconcile';

freshIndexedDBPerTest();

afterEach(closeAll);

/** Riverside's reconcile seat, its secret and public key, as Riverside's own log holds them. */
async function riversideSeat(ana: TestDevice, riverside: string) {
  const group = await ana.services.store.getGroup(riverside);
  const state = fold(group?.log ?? [], null);
  for (const p of state.proposals) {
    if (p.target.kind === 'reconcile')
      return { secret: fromBase64url(p.target.seat), key: p.target.key };
  }
  throw new Error('Expected Riverside’s reconcile Proposal.');
}

/**
 * A test store that holds Riverside's seat secret, as any member, former
 * member or invite holder could, joins under that seat and reports a pass
 * for it on the genesis.
 */
async function forgePass(
  mallory: TestDevice,
  secret: Uint8Array,
  seat: { secret: Uint8Array; key: string },
  coalition: string,
) {
  const entry = await mallory.services.store.addGroup(newEntry(secret, { name: 'Mallory' }));
  const joiner = publicKeyOf(entry.signingKey);
  const proof = base64url(signSeatProof(seat.secret, coalition, joiner));
  const join = signEvent(entry.signingKey, {
    type: 'join',
    group: coalition,
    ts: 0,
    body: { name: 'Mallory', seat: seat.key, proof },
  });
  const pass = signEvent(entry.signingKey, {
    type: 'group-result',
    group: coalition,
    ts: 0,
    body: { motion: coalition, seat: seat.key, result: 'pass' },
  });
  await mallory.services.store.enqueueAll(entry.groupId, [join.record, pass.record]);
  await mallory.services.sync.syncOnce();
}

describe('a result that doesn’t match the group’s vote', () => {
  it(
    'shows ResultMismatch to the group’s members, and the coalition doesn’t form',
    SLOW,
    async () => {
      const fake = createFakeRelay();
      const { ana, ben, cy, riverside, oak } = await twoGroups(fake);
      const { proposal, found, card } = await anaMakesCard(ana, cy, riverside);
      const brought = await bringCard(cy.services, found, oak, 'Cy');
      await syncAll();
      const coalitionId = (await coalitionOn(ana)).group ?? '';
      expect(coalitionId).not.toBe('');
      const mallory = await open(fake, 'mallory');
      await forgePass(mallory, card.secret, await riversideSeat(ana, riverside), coalitionId);
      await vote(riverside, proposal, [ana, cy], 0);
      await vote(oak, brought, [ben, cy]);
      await syncAll();

      expect((await coalitionOn(ben)).coalition?.status).toBe('declined');
      for (const device of [ana, cy]) {
        window.history.replaceState(null, '', `#/g/${riverside}`);
        const { unmount } = render(<App services={device.services} />);
        const coalitions = await screen.findByRole('region', { name: 'Coalitions' });
        expect(coalitions).toHaveTextContent(messages.coalitions.mismatch);
        expect(await axeViolations()).toEqual([]);
        unmount();
      }
      window.history.replaceState(null, '', `#/g/${oak}`);
      const { unmount } = render(<App services={ben.services} />);
      const oakHome = await screen.findByRole('region', { name: 'Coalitions' });
      expect(oakHome).not.toHaveTextContent(messages.coalitions.mismatch);
      expect(oakHome).toHaveTextContent('Riverside Tenants didn’t pass this');
      unmount();
    },
  );

  it('shows nothing of the kind when every result matches', SLOW, async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await twoGroups(fake);
    const { proposal, found } = await anaMakesCard(ana, cy, riverside);
    const brought = await bringCard(cy.services, found, oak, 'Cy');
    await syncAll(1);
    await vote(riverside, proposal, [ana, cy]);
    await vote(oak, brought, [ben, cy]);
    await syncAll();

    window.history.replaceState(null, '', `#/g/${riverside}`);
    render(<App services={ana.services} />);
    const coalitions = await screen.findByRole('region', { name: 'Coalitions' });
    expect(coalitions).toHaveTextContent('Formed');
    expect(coalitions).not.toHaveTextContent(messages.coalitions.mismatch);
  });
});
