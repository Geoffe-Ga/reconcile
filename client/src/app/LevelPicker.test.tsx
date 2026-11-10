import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_JOIN_LEVEL, type Level, LEVELS } from '../engine/capabilities';
import { parseRecord } from '../engine/event';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp } from '../test/members';
import { LevelPicker } from './LevelPicker';

freshIndexedDBPerTest();

const [FOLLOWING, VOTING, CREATING] = LEVELS;

/** The picker, controlled the way Join and People control it. */
function Controlled({ initial, onChange }: { initial: Level; onChange: (level: Level) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <main>
      <h1>Involvement</h1>
      <LevelPicker
        value={value}
        onChange={(level) => {
          setValue(level);
          onChange(level);
        }}
      />
    </main>
  );
}

function setup(initial: Level = DEFAULT_JOIN_LEVEL) {
  document.title = 'Join a group · Reconcile';
  const onChange = vi.fn<(level: Level) => void>();
  render(<Controlled initial={initial} onChange={onChange} />);
  return { user: userEvent.setup(), onChange };
}

const group = () => screen.getByRole('radiogroup', { name: 'Your involvement' });

/** The group's description, which React Aria also gives each radio after the radio's own line. */
const HINT = 'Everyone in this group sees your choice. You can change it at any time.';

describe('LevelPicker', () => {
  it('offers the three levels in order, each with its one line, and says who sees the choice', async () => {
    setup();
    expect(group()).toHaveAccessibleDescription(HINT);
    const radios = within(group()).getAllByRole('radio');
    expect(radios.map((radio) => radio.closest('label')?.textContent)).toEqual([
      'Member',
      'Collaborator',
      'Co-Creator',
    ]);
    expect(screen.getByRole('radio', { name: 'Member' })).toHaveAccessibleDescription(
      `Follow along and read ${HINT}`,
    );
    expect(screen.getByRole('radio', { name: 'Collaborator' })).toHaveAccessibleDescription(
      `Also vote, vouch and invite ${HINT}`,
    );
    expect(screen.getByRole('radio', { name: 'Co-Creator' })).toHaveAccessibleDescription(
      `Also propose changes and add versions ${HINT}`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the level it is given as chosen', () => {
    setup(FOLLOWING);
    expect(screen.getByRole('radio', { name: 'Member' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Collaborator' })).not.toBeChecked();
  });

  it('reports the level a person picks, by id', async () => {
    const { user, onChange } = setup();
    await user.click(screen.getByRole('radio', { name: 'Co-Creator' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(CREATING);
    expect(screen.getByRole('radio', { name: 'Co-Creator' })).toBeChecked();
  });

  it('moves between levels with the arrow keys', async () => {
    const { user, onChange } = setup(FOLLOWING);
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Member' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith(VOTING);
  });

  it('can be disabled, as while a change saves', () => {
    render(<LevelPicker value={VOTING} onChange={vi.fn()} isDisabled />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });
});

describe('choosing a level in the app', () => {
  const mounted: MountedApp[] = [];
  const opened: TestDevice[] = [];

  afterEach(() => {
    for (const app of mounted.splice(0)) app.unmount();
    for (const device of opened.splice(0)) device.services.store.close();
    window.history.replaceState(null, '', '#/');
  });

  it('queues one level event for Co-Creator, shows it once folded, and then offers Propose', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { groupId, devices } = await members(fake, ['Ana', 'Ben'], null, { Ben: VOTING });
    opened.push(...devices);
    const [ana, ben] = devices;
    if (ana === undefined || ben === undefined) throw new Error('Expected 2 devices.');
    go(`#/g/${groupId}`);
    const app = mountApp(ben.services, 'b');
    mounted.push(app);
    const b = within(app.container);
    const people = await b.findByRole('region', { name: 'People' });
    expect(
      within(people)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Ana, Co-Creator, Steward', 'Ben, invited by Ana, Collaborator']);

    // Ben chooses Co-Creator, offline, so the change waits in the outbox.
    fake.offline = true;
    await user.click(b.getByRole('radio', { name: 'Co-Creator' }));
    await user.click(b.getByRole('button', { name: 'Save your choice' }));
    await waitFor(async () => {
      const group = await ben.services.store.getGroup(groupId);
      const queued = (group?.outbox ?? []).map((record) => parseRecord(record)?.event);
      expect(queued).toEqual([
        expect.objectContaining({ type: 'level', body: { level: CREATING } }),
      ]);
    });
    expect(within(people).getByText('Ben', { selector: 'bdi' }).closest('li')).toHaveTextContent(
      'Ben, invited by Ana, Collaborator',
    );
    expect(await axeViolations()).toEqual([]);

    // Back online, the relay returns it, and the People list shows the new level.
    fake.offline = false;
    await act(() => ben.services.sync.syncOnce());
    await waitFor(() => {
      expect(
        within(people)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Ana, Co-Creator, Steward', 'Ben, invited by Ana, Co-Creator']);
    });
    expect(within(people).getByRole('status')).toHaveTextContent('Sent');

    // Ben can now propose: the Document view offers Propose a change.
    await user.click(b.getByRole('link', { name: /House rules/ }));
    expect(await b.findByRole('button', { name: 'Propose a change to section 1' })).toBeVisible();

    // Ana's device sees the same level after its next sync.
    await ana.services.sync.syncOnce();
    const anaGroup = await ana.services.store.getGroup(groupId);
    const levels = (anaGroup?.log ?? []).flatMap((record) => {
      const event = parseRecord(record.bytes)?.event;
      return event?.type === 'level' ? [event.body.level] : [];
    });
    expect(levels).toEqual([CREATING]);
  });
});
