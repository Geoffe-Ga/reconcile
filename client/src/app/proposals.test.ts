import { afterEach, describe, expect, it } from 'vitest';

import { publicKeyOf } from '../crypto/sign';
import { LEVELS } from '../engine/capabilities';
import { base64url, parseRecord } from '../engine/event';
import { fold } from '../engine/fold';
import { testDevice, type TestDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { createGroup } from './actions';
import { addVersion, castBallot, chooseLevel, propose, type ProposalValues } from './proposals';

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
        text: 'Quiet after 10pm.\n',
        link: 'https://chat.example.org/quiet',
      },
    });
    const group = await device.services.store.getGroup(groupId);
    expect(result).toEqual({
      outcome: 'proposed',
      proposalId: parseRecord(group?.outbox[0] ?? new Uint8Array())?.id,
    });
  });

  it('normalizes the proposed text as Atom text before signing it', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    fake.offline = true;
    const text = 'Cafe\u0301 hours  \r\nstart at ten.\t\r\n\r\n';
    await propose(device.services, groupId, {
      atom,
      title: 'Café',
      why: 'Why not.',
      text,
      link: null,
    });
    const [queued] = await outbox(device, groupId);
    expect(queued?.type === 'proposal' ? queued.body.text : null).toBe(
      'Caf\u00e9 hours\nstart at ten.\n',
    );
  });

  it('clears the draft for its Atom in the same change that queues it, and no other', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    const draft = { title: 'Café', why: 'Why not.', text: 'Quiet.', link: '' };
    await device.services.store.writeDraft(groupId, atom, draft);
    await device.services.store.writeDraft(groupId, 'other-atom', draft);
    await propose(device.services, groupId, { ...draft, atom, link: null });
    expect(await device.services.store.readDraft(groupId, atom)).toBeUndefined();
    expect(await device.services.store.readDraft(groupId, 'other-atom')).toEqual(draft);
  });

  it('keeps the draft when the Proposal is too large to queue', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    const draft = { title: 'Long', why: 'Why not.', text: 'x'.repeat(70_000), link: '' };
    await device.services.store.writeDraft(groupId, atom, draft);
    await propose(device.services, groupId, { ...draft, atom, link: null });
    expect(await device.services.store.readDraft(groupId, atom)).toEqual(draft);
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

  it('refuses a Proposal over 64,000 bytes, and queues nothing', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    const values = { atom, title: 'Long', why: 'Why not.', text: 'x'.repeat(70_000), link: null };
    expect(await propose(device.services, groupId, values)).toEqual({
      outcome: 'too-large',
    });
    expect(await outbox(device, groupId)).toEqual([]);
  });
});

describe('addVersion', () => {
  /** A founded group with Ana's Proposal on its first Atom, sent to the relay. */
  async function proposed(fake: FakeRelay) {
    const founding = await founded(fake);
    const { device, groupId, atom } = founding;
    const values = { atom, title: 'Quiet hours', why: 'Why not.', text: 'Quiet.', link: null };
    const result = await propose(device.services, groupId, values);
    if (result.outcome !== 'proposed') throw new Error('Expected a Proposal.');
    await device.services.sync.syncOnce();
    return { ...founding, proposal: result.proposalId };
  }

  it('queues one version, its text normalized as Atom text, and returns its id', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author, proposal } = await proposed(fake);
    fake.offline = true;
    const result = await addVersion(device.services, groupId, {
      proposal,
      text: 'Cafe\u0301 quiet  \r\nafter midnight.',
    });
    const queued = await outbox(device, groupId);
    expect(queued).toEqual([
      expect.objectContaining({
        type: 'version',
        group: groupId,
        author,
        body: { proposal, text: 'Caf\u00e9 quiet\nafter midnight.\n' },
      }),
    ]);
    const group = await device.services.store.getGroup(groupId);
    expect(result).toEqual({
      outcome: 'added',
      versionId: parseRecord(group?.outbox[0] ?? new Uint8Array())?.id,
    });
  });

  it('sends the version, which the fold puts on the ballot as version 2', async () => {
    const fake = createFakeRelay();
    const { device, groupId, proposal } = await proposed(fake);
    const result = await addVersion(device.services, groupId, { proposal, text: 'Later.' });
    await device.services.sync.syncOnce();
    const group = await device.services.store.getGroup(groupId);
    const state = fold(group?.log ?? [], group?.relayNow ?? null);
    expect(state.proposals[0]?.versions.map((v) => v.id)).toEqual([
      proposal,
      result.outcome === 'added' ? result.versionId : '',
    ]);
  });

  it('clears the draft kept for its Proposal in the same change, and no other', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom, proposal } = await proposed(fake);
    const draft = { title: '', why: '', text: 'Later.', link: '' };
    await device.services.store.writeDraft(groupId, proposal, draft);
    await device.services.store.writeDraft(groupId, atom, draft);
    await addVersion(device.services, groupId, { proposal, text: draft.text });
    expect(await device.services.store.readDraft(groupId, proposal)).toBeUndefined();
    expect(await device.services.store.readDraft(groupId, atom)).toEqual(draft);
  });

  it('takes a version record of exactly 64,000 bytes and refuses one a byte longer', async () => {
    const fake = createFakeRelay();
    const { device, groupId, proposal } = await proposed(fake);
    fake.offline = true;
    await addVersion(device.services, groupId, { proposal, text: 'x' });
    const lengths = async () =>
      ((await device.services.store.getGroup(groupId))?.outbox ?? []).map((entry) => entry.length);
    const [shortest = 0] = await lengths();
    const room = 64_000 - shortest;

    const fits = await addVersion(device.services, groupId, {
      proposal,
      text: 'x'.repeat(1 + room),
    });
    const over = await addVersion(device.services, groupId, {
      proposal,
      text: 'x'.repeat(2 + room),
    });

    expect([fits.outcome, over.outcome]).toEqual(['added', 'too-large']);
    expect(await lengths()).toEqual([shortest, 64_000]);
  });

  it('refuses a version over 64,000 bytes, queues nothing and keeps its draft', async () => {
    const fake = createFakeRelay();
    const { device, groupId, proposal } = await proposed(fake);
    const draft = { title: '', why: '', text: 'x'.repeat(70_000), link: '' };
    await device.services.store.writeDraft(groupId, proposal, draft);
    expect(await addVersion(device.services, groupId, { proposal, text: draft.text })).toEqual({
      outcome: 'too-large',
    });
    expect(await outbox(device, groupId)).toEqual([]);
    expect(await device.services.store.readDraft(groupId, proposal)).toEqual(draft);
  });
});

describe('castBallot', () => {
  it('queues a ballot scoring the Proposal, with its note trimmed and normalized', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    fake.offline = true;
    await castBallot(device.services, groupId, {
      proposal: 'proposal-1',
      scores: { 'proposal-1': 0 },
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

  it('scores every version it is given, by version id', async () => {
    const fake = createFakeRelay();
    const { device, groupId } = await founded(fake);
    fake.offline = true;
    await castBallot(device.services, groupId, {
      proposal: 'proposal-1',
      scores: { 'proposal-1': 2, 'version-2': 4, 'version-3': 1 },
      note: '',
    });
    const [vote] = await outbox(device, groupId);
    expect(vote?.body).toEqual({
      proposal: 'proposal-1',
      scores: { 'proposal-1': 2, 'version-2': 4, 'version-3': 1 },
    });
  });

  it('leaves a blank note out', async () => {
    const fake = createFakeRelay();
    const { device, groupId } = await founded(fake);
    fake.offline = true;
    await castBallot(device.services, groupId, {
      proposal: 'proposal-1',
      scores: { 'proposal-1': 4 },
      note: '  \n ',
    });
    const [vote] = await outbox(device, groupId);
    expect(vote?.body).toEqual({ proposal: 'proposal-1', scores: { 'proposal-1': 4 } });
  });
});

describe('chooseLevel', () => {
  it('queues one level event for this device’s member, and sends it', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    const [follow] = LEVELS;
    fake.offline = true;
    await chooseLevel(device.services, groupId, follow);
    expect(await outbox(device, groupId)).toEqual([
      {
        v: 1,
        type: 'level',
        group: groupId,
        author,
        ts: 1_762_650_000_000,
        body: { level: follow },
      },
    ]);

    fake.offline = false;
    await device.services.sync.syncOnce();
    const group = await device.services.store.getGroup(groupId);
    const state = fold(group?.log ?? [], group?.relayNow ?? null);
    expect(state.members.map((member) => member.level)).toEqual([follow]);
    expect(group?.outbox).toEqual([]);
  });

  it('refuses to choose a level in a group this device isn’t in', async () => {
    const fake = createFakeRelay();
    const { device } = await founded(fake);
    const [, vote] = LEVELS;
    await expect(chooseLevel(device.services, 'no-such-group', vote)).rejects.toThrow();
  });
});
