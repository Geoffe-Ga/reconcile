/**
 * Private drafts (#70, ADR-0073): one per group and target, kept inside the
 * group's own record on this device, and never sent anywhere.
 */
import { describe, expect, it, vi } from 'vitest';

import { text, utf8 } from '../test/bytes';
import { freshIndexedDBPerTest } from '../test/idb';
import { type NewGroup, openStore } from './db';
import { type Draft, draftIn, groupDrafts, isDraft, withDraft } from './drafts';

freshIndexedDBPerTest();

const group: NewGroup = {
  groupId: 'group-1',
  secret: new Uint8Array(32).fill(9),
  signingKey: new Uint8Array(32).fill(7),
  me: { author: 'author-ana', name: 'Ana' },
};

const draft: Draft = {
  title: 'Later quiet hours',
  why: 'Weekends run late.',
  text: 'Quiet after **11pm**.\n',
  link: 'https://chat.example.org/later',
};

async function storeWithGroup() {
  const store = await openStore();
  await store.addGroup(group);
  return store;
}

describe('drafts in the store', () => {
  it('reads back the draft saved for a group and target', async () => {
    const store = await storeWithGroup();
    await store.writeDraft(group.groupId, 'atom-1', draft);
    expect(await store.readDraft(group.groupId, 'atom-1')).toEqual(draft);
  });

  it('has none for a target nobody drafted, whatever its name', async () => {
    const store = await storeWithGroup();
    expect(await store.readDraft(group.groupId, 'atom-1')).toBeUndefined();
    await store.writeDraft(group.groupId, 'atom-1', draft);
    for (const target of ['atom-2', '__proto__', 'constructor', 'toString']) {
      expect(await store.readDraft(group.groupId, target)).toBeUndefined();
    }
  });

  it('keeps one draft per target, replacing it on each save', async () => {
    const store = await storeWithGroup();
    await store.writeDraft(group.groupId, 'atom-1', draft);
    await store.writeDraft(group.groupId, 'atom-2', { ...draft, title: 'Bins' });
    await store.writeDraft(group.groupId, 'atom-1', { ...draft, title: 'Quiet' });
    expect(await store.readDraft(group.groupId, 'atom-1')).toEqual({ ...draft, title: 'Quiet' });
    expect(await store.readDraft(group.groupId, 'atom-2')).toEqual({ ...draft, title: 'Bins' });
  });

  it('clears one target’s draft and leaves the others', async () => {
    const store = await storeWithGroup();
    await store.writeDraft(group.groupId, 'atom-1', draft);
    await store.writeDraft(group.groupId, 'atom-2', draft);
    await store.writeDraft(group.groupId, 'atom-1', null);
    expect(await store.readDraft(group.groupId, 'atom-1')).toBeUndefined();
    expect(await store.readDraft(group.groupId, 'atom-2')).toEqual(draft);
  });

  it('keeps drafts under the group’s own record, so whatever removes the group removes them', async () => {
    const store = await storeWithGroup();
    await store.writeDraft(group.groupId, 'atom-1', draft);
    const stored = await store.getGroup(group.groupId);
    expect(stored?.drafts).toEqual(new Map([['atom-1', draft]]));
  });

  it('keeps drafts apart between groups', async () => {
    const store = await storeWithGroup();
    await store.addGroup({ ...group, groupId: 'group-2' });
    await store.writeDraft(group.groupId, 'atom-1', draft);
    expect(await store.readDraft('group-2', 'atom-1')).toBeUndefined();
  });

  it('never queues a draft for the relay', async () => {
    const store = await storeWithGroup();
    await store.writeDraft(group.groupId, 'atom-1', draft);
    expect((await store.getGroup(group.groupId))?.outbox).toEqual([]);
  });

  it('tells no subscriber about a draft: no screen shows another’s drafts', async () => {
    const store = await storeWithGroup();
    const listener = vi.fn();
    store.subscribe(listener);
    await store.writeDraft(group.groupId, 'atom-1', draft);
    await store.writeDraft(group.groupId, 'atom-1', null);
    expect(listener).not.toHaveBeenCalled();
  });

  it('refuses a draft for a group the device isn’t in', async () => {
    const store = await openStore();
    await expect(store.writeDraft('missing', 'atom-1', draft)).rejects.toThrow(
      'No such group on this device.',
    );
    expect(await store.readDraft('missing', 'atom-1')).toBeUndefined();
  });

  it('clears a target’s draft in the same change that queues its Proposal', async () => {
    const store = await storeWithGroup();
    await store.writeDraft(group.groupId, 'atom-1', draft);
    await store.writeDraft(group.groupId, 'atom-2', draft);
    const listener = vi.fn();
    store.subscribe(listener);
    await store.enqueue(group.groupId, utf8('{"proposal":1}'), 'atom-1');
    const stored = await store.getGroup(group.groupId);
    expect(stored?.outbox.map(text)).toEqual(['{"proposal":1}']);
    expect(stored?.drafts).toEqual(new Map([['atom-2', draft]]));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('leaves drafts alone when queuing an event with no draft', async () => {
    const store = await storeWithGroup();
    await store.writeDraft(group.groupId, 'atom-1', draft);
    await store.enqueue(group.groupId, utf8('{"vote":1}'));
    expect(await store.readDraft(group.groupId, 'atom-1')).toEqual(draft);
  });
});

describe('draft helpers', () => {
  it('read a record kept before drafts existed as having none', () => {
    expect(draftIn({}, 'atom-1')).toBeUndefined();
  });

  it('read back a draft’s voting window with it (#106)', async () => {
    const store = await storeWithGroup();
    await store.writeDraft(group.groupId, 'atom-1', { ...draft, window: 10 });
    expect(await store.readDraft(group.groupId, 'atom-1')).toEqual({ ...draft, window: 10 });
  });

  it('read back a draft’s Dispatch with it (#112)', async () => {
    const store = await storeWithGroup();
    const dispatch = { title: 'Updated: House rules', text: 'Quiet hours moved.' };
    await store.writeDraft(group.groupId, 'atom-1', { ...draft, dispatch });
    expect(await store.readDraft(group.groupId, 'atom-1')).toEqual({ ...draft, dispatch });
  });

  it('skip a stored value that isn’t a whole draft', () => {
    const odd = new Map<string, unknown>([['atom-1', { title: 'x' }]]);
    expect(draftIn({ drafts: odd as Map<string, Draft> }, 'atom-1')).toBeUndefined();
  });

  it('add, replace and remove a draft without touching the map they were given', () => {
    const before = new Map([['atom-1', draft]]);
    const added = withDraft(before, 'atom-2', draft);
    const removed = withDraft(added, 'atom-1', null);
    expect([...before.keys()]).toEqual(['atom-1']);
    expect([...added.keys()]).toEqual(['atom-1', 'atom-2']);
    expect([...removed.keys()]).toEqual(['atom-2']);
    expect(withDraft(undefined, 'atom-1', draft)).toEqual(new Map([['atom-1', draft]]));
  });

  it.each([
    ['a whole draft', draft, true],
    ['null', null, false],
    ['a string', 'draft', false],
    ['a draft missing its link', { title: '', why: '', text: '' }, false],
    ['a draft with a number', { ...draft, why: 2 }, false],
    ['a draft with a voting window', { ...draft, window: 10 }, true],
    ['a draft with a blank voting window', { ...draft, window: Number.NaN }, true],
    ['a draft with a voting window as text', { ...draft, window: '10' }, false],
    [
      'a draft with a Dispatch (#112)',
      { ...draft, dispatch: { title: 'Updated', text: '' } },
      true,
    ],
    ['a new Document’s draft, with its title (#92)', { ...draft, documentTitle: 'Budget' }, true],
    ['a new Document’s draft with a numeric title', { ...draft, documentTitle: 1 }, false],
    ['a draft with a Dispatch as text', { ...draft, dispatch: 'Updated' }, false],
    ['a draft with a null Dispatch', { ...draft, dispatch: null }, false],
    ['a draft with a Dispatch missing its text', { ...draft, dispatch: { title: 'U' } }, false],
    [
      'a draft with a Dispatch title as a number',
      { ...draft, dispatch: { title: 1, text: '' } },
      false,
    ],
  ])('know %s when they see it', (_name, value, expected) => {
    expect(isDraft(value)).toBe(expected);
  });
});

describe('groupDrafts', () => {
  it('loads, saves and clears one group’s drafts', async () => {
    const store = await storeWithGroup();
    const drafts = groupDrafts(store, group.groupId);
    expect(await drafts.load('atom-1')).toBeUndefined();
    await drafts.save('atom-1', draft);
    expect(await drafts.load('atom-1')).toEqual(draft);
    expect(await store.readDraft(group.groupId, 'atom-1')).toEqual(draft);
    await drafts.clear('atom-1');
    expect(await drafts.load('atom-1')).toBeUndefined();
  });
});
