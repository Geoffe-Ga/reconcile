import { afterEach, describe, expect, it } from 'vitest';

import { publicKeyOf } from '../crypto/sign';
import { LEVELS } from '../engine/capabilities';
import { base64url, parseRecord } from '../engine/event';
import { fold } from '../engine/fold';
import { testDevice, type TestDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { deadlineOf } from '../test/votes';
import { createGroup } from './actions';
import {
  addVersion,
  againDraft,
  castBallot,
  chooseLevel,
  propose,
  type ProposalValues,
  proposeDissolve,
  proposeRemoval,
  proposeRules,
  proposeSteward,
  respondToRemoval,
  sendDispatch,
  suspend,
  vouch,
} from './proposals';

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

/** The body of the one `proposal` in a group's outbox. */
async function queuedProposal(device: TestDevice, groupId: string) {
  const [queued] = await outbox(device, groupId);
  if (queued?.type !== 'proposal') throw new Error('Expected a queued proposal.');
  return queued.body;
}

describe('sendDispatch (#112)', () => {
  it('queues one dispatch, NFC-normalized, with its Document, and returns its id', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    fake.offline = true;
    const id = await sendDispatch(device.services, groupId, {
      title: 'Cafe\u0301 on Sunday',
      text: 'Bring a chair.\nWe start at 10.',
      doc: groupId,
    });

    const queued = await outbox(device, groupId);
    expect(queued).toEqual([
      {
        v: 1,
        type: 'dispatch',
        group: groupId,
        author,
        ts: expect.any(Number) as number,
        body: {
          title: 'Caf\u00e9 on Sunday',
          text: 'Bring a chair.\nWe start at 10.',
          doc: groupId,
        },
      },
    ]);
    const group = await device.services.store.getGroup(groupId);
    expect(id).toBe(parseRecord(group?.outbox[0] ?? new Uint8Array())?.id);
  });

  it('leaves out a doc when none is chosen, and sends it once the relay is back', async () => {
    const fake = createFakeRelay();
    const { device, groupId } = await founded(fake);
    const id = await sendDispatch(device.services, groupId, {
      title: 'Meet on Sunday',
      text: '',
      doc: null,
    });
    await device.services.sync.syncOnce();

    const group = await device.services.store.getGroup(groupId);
    const state = fold(group?.log ?? [], group?.relayNow ?? null);
    expect(group?.outbox).toEqual([]);
    expect(state.dispatches).toEqual([
      expect.objectContaining({
        id,
        title: 'Meet on Sunday',
        text: '',
        doc: null,
      }),
    ]);
  });
});

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

  it('carries a Dispatch, NFC-normalized, when the values hold one (#112)', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    fake.offline = true;
    await propose(device.services, groupId, {
      atom,
      title: 'Quiet hours',
      why: 'Sleep.',
      text: 'Quiet after 10pm.',
      link: null,
      dispatch: { title: 'Updated: House rules', text: 'Cafe\u0301 hours moved.' },
    });
    expect(await queuedProposal(device, groupId)).toMatchObject({
      dispatch: { title: 'Updated: House rules', text: 'Caf\u00e9 hours moved.' },
    });
  });

  it('carries no dispatch key when the values hold none', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    fake.offline = true;
    const values = { atom, title: 'Quiet hours', why: 'Sleep.', text: 'Quiet.', link: null };
    await propose(device.services, groupId, values);
    expect(Object.keys(await queuedProposal(device, groupId))).not.toContain('dispatch');
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
    const body = queued?.type === 'proposal' ? queued.body : null;
    expect(body !== null && 'text' in body ? body.text : null).toBe(
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

  it('writes the window the proposer chose, which sets the folded deadline (#106)', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    const values = { atom, title: 'Quiet hours', why: 'Why not.', text: 'Quiet.', link: null };
    await propose(device.services, groupId, { ...values, window: 10 });
    expect(await queuedProposal(device, groupId)).toMatchObject({ window: 10 });
    await device.services.sync.syncOnce();

    const group = await device.services.store.getGroup(groupId);
    if (group === undefined) throw new Error('Expected the group.');
    const [folded] = fold(group.log, group.relayNow).proposals;
    if (folded === undefined) throw new Error('Expected the Proposal to open.');
    expect(folded.window).toBe(10);
    expect(folded.deadline).toBe(folded.received + 10 * 1_440);
  });

  it('leaves the window out when none is given, so the class default applies', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    fake.offline = true;
    const values = { atom, title: 'Quiet hours', why: 'Why not.', text: 'Quiet.', link: null };
    await propose(device.services, groupId, values);
    expect(await queuedProposal(device, groupId)).not.toHaveProperty('window');
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

describe('propose, again', () => {
  const values = (atom: string): ProposalValues => ({
    atom,
    title: 'Quiet hours',
    why: 'Why not.',
    text: 'Quiet after 10pm.',
    link: null,
    again: 'lapsed-proposal',
    versions: ['Quiet after midnight.', 'Quiet after eleven.'],
  });

  it('queues the proposal, then one version of it per other text, and clears the again draft', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    fake.offline = true;
    const draft = { title: 'Quiet hours', why: 'Why not.', text: 'Quiet.', link: '' };
    await device.services.store.writeDraft(groupId, againDraft('lapsed-proposal'), draft);
    await device.services.store.writeDraft(groupId, atom, draft);

    const result = await propose(device.services, groupId, values(atom));

    if (result.outcome !== 'proposed') throw new Error('Expected a Proposal.');
    const queued = await outbox(device, groupId);
    expect(queued.map((event) => event?.type)).toEqual(['proposal', 'version', 'version']);
    expect(queued.slice(1).map((event) => event?.body)).toEqual([
      { proposal: result.proposalId, text: 'Quiet after midnight.\n' },
      { proposal: result.proposalId, text: 'Quiet after eleven.\n' },
    ]);
    const store = device.services.store;
    expect(await store.readDraft(groupId, againDraft('lapsed-proposal'))).toBeUndefined();
    expect(await store.readDraft(groupId, atom)).toEqual(draft);
  });

  it('folds as a fresh Proposal with every version, and its own 7-day window', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    fake.minute += 20_000;
    const received = fake.minute;
    const result = await propose(device.services, groupId, values(atom));
    await device.services.sync.syncOnce();

    const group = await device.services.store.getGroup(groupId);
    const state = fold(group?.log ?? [], group?.relayNow ?? null);
    const [proposal] = state.proposals;
    expect(proposal?.id).toBe(result.outcome === 'proposed' ? result.proposalId : '');
    expect(proposal?.received).toBe(received);
    expect(proposal?.deadline).toBe(deadlineOf(received));
    expect(proposal?.versions.map((version) => version.text)).toEqual([
      'Quiet after 10pm.\n',
      'Quiet after midnight.\n',
      'Quiet after eleven.\n',
    ]);
    expect(state.ignored).toEqual([]);
  });

  it('queues nothing when any version is too large for a blob', async () => {
    const fake = createFakeRelay();
    const { device, groupId, atom } = await founded(fake);
    const big = { ...values(atom), versions: ['Short.', 'x'.repeat(70_000)] };
    expect(await propose(device.services, groupId, big)).toEqual({ outcome: 'too-large' });
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

describe('proposeSteward', () => {
  it('queues one steward Proposal for the seat and nominee, NFC-normalized, and returns its id', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    fake.offline = true;
    const nominee = 'b'.repeat(43);
    const result = await proposeSteward(device.services, groupId, {
      seat: 2,
      member: nominee,
      title: 'Cafe\u0301 steward',
      why: 'Calm.',
    });
    const queued = await outbox(device, groupId);
    expect(queued).toEqual([
      {
        v: 1,
        type: 'proposal',
        group: groupId,
        author,
        ts: 1_762_650_000_000,
        body: {
          target: { kind: 'steward', seat: 2, member: nominee },
          title: 'Caf\u00e9 steward',
          why: 'Calm.',
        },
      },
    ]);
    const group = await device.services.store.getGroup(groupId);
    const id = parseRecord(group?.outbox[0] ?? new Uint8Array())?.id;
    expect(result).toEqual({ outcome: 'proposed', proposalId: id });
  });

  it('writes a recall with no nominee', async () => {
    const fake = createFakeRelay();
    const { device, groupId } = await founded(fake);
    fake.offline = true;
    await proposeSteward(device.services, groupId, {
      seat: 1,
      member: null,
      title: 'Recall',
      why: 'Talked it over.',
    });
    const [queued] = await outbox(device, groupId);
    expect(queued?.body).toEqual({
      target: { kind: 'steward', seat: 1, member: null },
      title: 'Recall',
      why: 'Talked it over.',
    });
  });

  it('refuses a steward Proposal too large for any blob, and queues nothing', async () => {
    const fake = createFakeRelay();
    const { device, groupId } = await founded(fake);
    const why = 'x'.repeat(70_000);
    const result = await proposeSteward(device.services, groupId, {
      seat: 1,
      member: null,
      title: 'Recall',
      why,
    });
    expect(result).toEqual({ outcome: 'too-large' });
    expect(await outbox(device, groupId)).toEqual([]);
  });
});

describe('proposeRules', () => {
  const webhook = 'https://discord.com/api/webhooks/1/abc';

  it('queues one rules Proposal, NFC-normalized, and returns its id', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    fake.offline = true;
    const result = await proposeRules(device.services, groupId, {
      optIn: 'chatBot',
      value: { webhook },
      title: 'Cafe\u0301 bot',
      why: 'Nudges.',
      narrow: false,
    });
    const queued = await outbox(device, groupId);
    expect(queued).toEqual([
      {
        v: 1,
        type: 'proposal',
        group: groupId,
        author,
        ts: 1_762_650_000_000,
        body: {
          target: { kind: 'rules', optIn: 'chatBot', value: { webhook } },
          title: 'Caf\u00e9 bot',
          why: 'Nudges.',
        },
      },
    ]);
    const group = await device.services.store.getGroup(groupId);
    const id = parseRecord(group?.outbox[0] ?? new Uint8Array())?.id;
    expect(result).toEqual({ outcome: 'proposed', proposalId: id });
  });

  it('queues the off-Proposal and then a narrow naming it, in one change, for Turn off now', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    fake.offline = true;
    const result = await proposeRules(device.services, groupId, {
      optIn: 'frontDoor',
      value: false,
      title: 'Close the front door',
      why: 'Someone posted the address.',
      narrow: true,
      window: 3,
    });
    if (result.outcome !== 'proposed') throw new Error('Expected a Proposal.');
    const queued = await outbox(device, groupId);
    expect(queued.map((event) => event?.type)).toEqual(['proposal', 'narrow']);
    expect(queued[0]?.body).toEqual({
      target: { kind: 'rules', optIn: 'frontDoor', value: false },
      title: 'Close the front door',
      why: 'Someone posted the address.',
      window: 3,
    });
    expect(queued[1]).toEqual({
      v: 1,
      type: 'narrow',
      group: groupId,
      author,
      ts: 1_762_650_000_000,
      body: { optIn: 'frontDoor', proposal: result.proposalId },
    });
  });

  it('refuses a rules Proposal too large for any blob, and queues nothing', async () => {
    const fake = createFakeRelay();
    const { device, groupId } = await founded(fake);
    const result = await proposeRules(device.services, groupId, {
      optIn: 'frontDoor',
      value: false,
      title: 'Close it',
      why: 'x'.repeat(70_000),
      narrow: true,
    });
    expect(result).toEqual({ outcome: 'too-large' });
    expect(await outbox(device, groupId)).toEqual([]);
  });
});

describe('proposeDissolve', () => {
  it('queues one dissolve Proposal with its wipe and window, NFC-normalized, and returns its id (#108)', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    fake.offline = true;
    const result = await proposeDissolve(device.services, groupId, {
      title: 'Dissolve the cafe\u0301 group',
      why: 'We all moved.',
      window: 21,
      wipe: true,
    });
    const queued = await outbox(device, groupId);
    expect(queued).toEqual([
      {
        v: 1,
        type: 'proposal',
        group: groupId,
        author,
        ts: 1_762_650_000_000,
        body: {
          target: { kind: 'dissolve', wipe: true },
          title: 'Dissolve the caf\u00e9 group',
          why: 'We all moved.',
          window: 21,
        },
      },
    ]);
    const group = await device.services.store.getGroup(groupId);
    const id = parseRecord(group?.outbox[0] ?? new Uint8Array())?.id;
    expect(result).toEqual({ outcome: 'proposed', proposalId: id });
  });

  it('refuses a dissolve Proposal too large for any blob, and queues nothing', async () => {
    const fake = createFakeRelay();
    const { device, groupId } = await founded(fake);
    const values = { title: 'Dissolve', why: 'x'.repeat(70_000), window: 14, wipe: false };
    expect(await proposeDissolve(device.services, groupId, values)).toEqual({
      outcome: 'too-large',
    });
    expect(await outbox(device, groupId)).toEqual([]);
  });
});

describe('proposeRemoval and respondToRemoval (#115)', () => {
  const KIM = 'S2ltS2ltS2ltS2ltS2ltS2ltS2ltS2ltS2ltS2ltS2k';

  it('queues one removal with no window, NFC-normalized, and returns its id', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    fake.offline = true;
    const result = await proposeRemoval(device.services, groupId, {
      member: KIM,
      title: 'Remove Kim from the cafe\u0301',
      why: 'Threats in the chat.',
    });
    expect(await outbox(device, groupId)).toEqual([
      {
        v: 1,
        type: 'proposal',
        group: groupId,
        author,
        ts: 1_762_650_000_000,
        body: {
          target: { kind: 'remove', member: KIM },
          title: 'Remove Kim from the caf\u00e9',
          why: 'Threats in the chat.',
        },
      },
    ]);
    const group = await device.services.store.getGroup(groupId);
    const id = parseRecord(group?.outbox[0] ?? new Uint8Array())?.id;
    expect(result).toEqual({ outcome: 'proposed', proposalId: id });
  });

  it('refuses a removal too large for any blob, and queues nothing', async () => {
    const fake = createFakeRelay();
    const { device, groupId } = await founded(fake);
    const values = { member: KIM, title: 'Remove Kim', why: 'x'.repeat(70_000) };
    expect(await proposeRemoval(device.services, groupId, values)).toEqual({
      outcome: 'too-large',
    });
    expect(await outbox(device, groupId)).toEqual([]);
  });

  it('queues one response, trimmed and NFC-normalized', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    fake.offline = true;
    await respondToRemoval(device.services, groupId, {
      proposal: 'p1',
      text: '  I wasn’t at the cafe\u0301.\n ',
    });
    expect(await outbox(device, groupId)).toEqual([
      {
        v: 1,
        type: 'removal-response',
        group: groupId,
        author,
        ts: 1_762_650_000_000,
        body: { proposal: 'p1', text: 'I wasn’t at the caf\u00e9.' },
      },
    ]);
  });
});

describe('suspend', () => {
  it('queues one suspend naming the member, with its reason trimmed and normalized', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    fake.offline = true;
    const member = 'k'.repeat(43);
    await suspend(device.services, groupId, { member, reason: '  Cafe\u0301 threats.  ' });
    expect(await outbox(device, groupId)).toEqual([
      {
        v: 1,
        type: 'suspend',
        group: groupId,
        author,
        ts: 1_762_650_000_000,
        body: { member, reason: 'Caf\u00e9 threats.' },
      },
    ]);
  });

  it('leaves a blank reason out', async () => {
    const fake = createFakeRelay();
    const { device, groupId } = await founded(fake);
    fake.offline = true;
    const member = 'k'.repeat(43);
    await suspend(device.services, groupId, { member, reason: '   ' });
    const [queued] = await outbox(device, groupId);
    expect(queued?.body).toEqual({ member });
  });
});

describe('vouch', () => {
  it('queues one vouch naming the newcomer, signed by this device’s member (#101)', async () => {
    const fake = createFakeRelay();
    const { device, groupId, author } = await founded(fake);
    fake.offline = true;
    const member = 'k'.repeat(43);
    await vouch(device.services, groupId, member);
    expect(await outbox(device, groupId)).toEqual([
      { v: 1, type: 'vouch', group: groupId, author, ts: 1_762_650_000_000, body: { member } },
    ]);
  });
});
