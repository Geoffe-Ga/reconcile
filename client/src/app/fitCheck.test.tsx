/**
 * The fit check (#71): Create group and the composer build the real signed
 * record and refuse it, tied to the field, when it's over 64,000 bytes, so a
 * record that #73 couldn't carry in one invite chunk is never queued. Bytes
 * count, not characters: each "é" below is one character and two bytes.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { genesisAtoms, normalizeAtomText } from '../engine/atomText';
import { type EventDraft, signEvent } from '../engine/event';
import { DEFAULT_RULES } from '../engine/rules';
import { type TestDevice, testDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { testKeys } from '../test/keys';
import { members } from '../test/members';
import { App } from './App';

freshIndexedDBPerTest();

/** The largest record a device queues (spec §2), written out so the test pins it. */
const LIMIT = 64_000;

/** The device clock `testDevice` gives every event's `ts`. */
const NOW = 1_762_650_000_000;

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

/** The length of `draft`'s record. Every key is 32 bytes, so any member's is as long. */
function recordLength(draft: EventDraft): number {
  return signEvent(testKeys('ana').secretKey, draft).record.length;
}

/**
 * Text of two-byte "é"s, then an "x" when needed, that makes `draftOf`'s
 * record exactly `bytes` long.
 */
function textFor(bytes: number, draftOf: (text: string) => EventDraft): string {
  const room = bytes - (recordLength(draftOf('x')) - 1);
  const text = 'é'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2);
  expect(recordLength(draftOf(text))).toBe(bytes);
  expect(text.length).toBeLessThan(LIMIT / 2 + 1);
  return text;
}

/** Clears the field `label` and pastes `value` into it. */
async function enter(user: UserEvent, label: string, value: string): Promise<void> {
  const box = screen.getByRole('textbox', { name: label });
  await user.clear(box);
  await user.click(box);
  await user.paste(value);
}

describe('Create group', () => {
  const NAMES = { name: 'Riverside Tenants', founder: 'Ana', title: 'House rules' };
  const genesis = (text: string): EventDraft => ({
    type: 'genesis',
    group: '',
    ts: NOW,
    body: { ...NAMES, atoms: genesisAtoms(text), rules: DEFAULT_RULES },
  });

  it('refuses a founding Document whose record is 64,001 bytes, tied to its text, and queues nothing', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const ana = await testDevice(fake, 'ana');
    opened.push(ana);
    window.history.replaceState(null, '', '#/create');
    render(<App services={ana.services} />);
    await enter(user, 'Group name', NAMES.name);
    await enter(user, 'Your name', NAMES.founder);
    await enter(user, 'Document title', NAMES.title);

    await enter(user, 'Document text', textFor(LIMIT + 1, genesis));
    await user.click(screen.getByRole('button', { name: 'Create group' }));

    const text = screen.getByRole('textbox', { name: 'Document text' });
    await waitFor(() => {
      expect(text).toHaveAttribute('aria-invalid', 'true');
    });
    expect(text).toHaveAccessibleDescription(
      /This Document is too long to send\. Shorten it, then try again\./,
    );
    expect(await ana.services.store.listGroups()).toEqual([]);
    expect(fake.requests).toEqual([]);

    // One byte less fits, and the group is made.
    await enter(user, 'Document text', textFor(LIMIT, genesis));
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    const [group] = await ana.services.store.listGroups();
    expect(group?.log.map((record) => record.bytes.length)).toEqual([LIMIT]);
  });
});

describe('the composer', () => {
  it('refuses a Proposal whose record is 64,001 bytes, tied to its new text, and queues nothing', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { groupId, devices } = await members(fake, ['Ana']);
    opened.push(...devices);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected a device.');
    const atom = `${groupId}.0`;
    const values = { title: 'Longer quiet hours', why: 'Weekends run late.' };
    const proposal = (text: string): EventDraft => ({
      type: 'proposal',
      group: groupId,
      ts: NOW,
      body: { atom, ...values, text: normalizeAtomText(text) },
    });
    const sentBefore = fake.requests.length;
    window.history.replaceState(null, '', `#/g/${groupId}/propose/${atom}`);
    render(<App services={ana.services} />);
    await screen.findByRole('heading', { level: 1, name: 'Propose a change' });
    await enter(user, 'Title', values.title);
    await enter(user, 'Why', values.why);

    await enter(user, 'New text', textFor(LIMIT + 1, proposal));
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));

    const text = screen.getByRole('textbox', { name: 'New text' });
    await waitFor(() => {
      expect(text).toHaveAttribute('aria-invalid', 'true');
    });
    expect(text).toHaveAccessibleDescription(
      /This is too long to send\. Shorten it, then try again\./,
    );
    expect((await ana.services.store.getGroup(groupId))?.outbox).toEqual([]);
    await act(() => ana.services.sync.syncOnce());
    const puts = fake.requests.slice(sentBefore).filter((request) => request.method === 'PUT');
    expect(puts).toEqual([]);
    expect(within(document.body).queryByRole('radiogroup', { name: 'Your score' })).toBeNull();
  });
});
