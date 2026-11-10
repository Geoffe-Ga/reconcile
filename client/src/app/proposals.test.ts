import { afterEach, describe, expect, it } from 'vitest';

import { publicKeyOf } from '../crypto/sign';
import { base64url, parseRecord } from '../engine/event';
import { fold } from '../engine/fold';
import { testDevice, type TestDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { createGroup } from './actions';
import { castBallot, propose, type ProposalValues } from './proposals';

freshIndexedDBPerTest();

const devices: TestDevice[] = [];

afterEach(() => {
  for (const device of devices.splice(0)) device.services.store.close();
});

/** A device with a group sent to the relay, and its id, author and first Atom. */
async function founded(fake: FakeRelay) {
  const device = await testDevice(fake, 'ana');
  devices.push(device);
  const created = await createGroup(device.services, {
    groupName: 'Riverside Tenants',
    yourName: 'Ana',
    chat: null,
    title: 'House rules',
    text: 'Quiet hours start at ten.',
  });
  if (created.outcome !== 'created') throw new Error('Expected a group.');
  await device.services.sync.syncOnce();
  const group = await device.services.store.getGroup(created.groupId);
  if (group === undefined) throw new Error('Expected the group.');
  return {
    device,
    groupId: created.groupId,
    author: group.me.author,
    atom: `${created.groupId}.0`,
  };
}

/** The events in a group's outbox, read back. */
async function outbox(device: TestDevice, groupId: string) {
  const group = await device.services.store.getGroup(groupId);
  return (group?.outbox ?? []).map((bytes) => parseRecord(bytes)?.event);
}

describe('propose', () => {
  it('queues one proposal, NFC-normalized, and returns its id', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author, atom } = await founded(fake);
    fake.offline = true;
    const values: ProposalValues = {
      atom,
      title: 'Café hours',
      why: 'Quieter evenings.',
      text: 'Quiet after 10pm.',
      link: 'https://chat.example.org/quiet',
    };
    const result = await propose(device.services, groupId, values);

    const queued = await outbox(device, groupId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: 'proposal',
      group: groupId,
      author,
      body: {
        atom,
        title: 'Café hours',
        why: 'Quieter evenings.',
        text: 'Quiet after 10pm.',
        link: 'https://chat.example.org/quiet',
      },
    });
    const group = await device.services.store.getGroup(groupId);
    expect(result).toEqual({
      outcome: 'proposed',
      proposalId: parseRecord(group?.outbox[0] ?? new Uint8Array())?.id,
    });
  });

  it('leaves the link out when there is none, and sends the Proposal', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    const values = { atom, title: 'Quiet hours', why: 'Why not.', text: 'Quiet.', link: null };
    const result = await propose(device.services, groupId, values);
    await device.services.sync.syncOnce();

    const group = await device.services.store.getGroup(groupId);
    const state = fold(group?.log ?? [], group?.relayNow ?? null);
    expect(state.proposals.map((p) => [p.id, p.link])).toEqual([
      [result.outcome === 'proposed' ? result.proposalId : '', null],
    ]);
  });

  it('signs as this device’s member of the group, with the key kept for it', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    const values = { atom, title: 'Quiet hours', why: 'Why not.', text: 'Quiet.', link: null };
    await propose(device.services, groupId, values);
    const group = await device.services.store.getGroup(groupId);
    const record = group?.outbox[0] ?? new Uint8Array();
    expect(base64url(record.subarray(0, 32))).toBe(group?.me.author);
    expect(base64url(publicKeyOf(group?.signingKey ?? new Uint8Array(32)))).toBe(group?.me.author);
  });

  it('refuses to propose in a group this device isn’t in', async () => {
    const fake = createFakeRelay();
    const { device, atom } = await founded(fake);
    const values = { atom, title: 'Quiet hours', why: 'Why not.', text: 'Quiet.', link: null };
    await expect(propose(device.services, 'elsewhere', values)).rejects.toThrow(
      'No such group on this device.',
    );
  });

  it('refuses a Proposal too large for any blob, and queues nothing', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    const values = { atom, title: 'Long', why: 'Why not.', text: 'x'.repeat(70_000), link: null };
    expect(await propose(device.services, groupId, values)).toEqual({
      outcome: 'too-large',
    });
    expect(await outbox(device, groupId)).toEqual([]);
  });
});

describe('castBallot', () => {
  it('queues a ballot scoring the Proposal, with its note trimmed and normalized', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    fake.offline = true;
    await castBallot(device.services, groupId, {
      proposal: 'proposal-1',
      score: 0,
      note: '  Too early for the café.  ',
    });
    expect(await outbox(device, groupId)).toEqual([
      expect.objectContaining({
        type: 'vote',
        author,
        body: {
          proposal: 'proposal-1',
          scores: { 'proposal-1': 0 },
          note: 'Too early for the café.',
        },
      }),
    ]);
  });

  it('leaves a blank note out', async () => {
    const fake = createFakeRelay();
    const { device, groupId } = await founded(fake);
    fake.offline = true;
    await castBallot(device.services, groupId, {
      proposal: 'proposal-1',
      score: 4,
      note: '  \n ',
    });
    const [vote] = await outbox(device, groupId);
    expect(vote?.body).toEqual({ proposal: 'proposal-1', scores: { 'proposal-1': 4 } });
  });
});
