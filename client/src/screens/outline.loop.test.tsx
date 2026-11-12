/**
 * An outline through the whole app (#103), on two devices that share one fake
 * relay. Ana picks Section header from an Add a section here and proposes
 * 'Values', which queues an add whose text is `# Values\n`; then she moves a
 * section to the start with Move this section. Both pass, and both devices
 * read the same order, the header set as a header.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { castBallot } from '../app/proposals';
import { parseRecord } from '../engine/event';
import type { TestDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { APP_USER, go, members, type MountedApp, mountApp } from '../test/members';

freshIndexedDBPerTest();

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

function mount(device: TestDevice | undefined, prefix: string): HTMLElement {
  if (device === undefined) throw new Error('Expected a device.');
  const app = mountApp(device.services, prefix);
  mounted.push(app);
  return app.container;
}

async function sync(device: TestDevice | undefined): Promise<void> {
  await act(() => device?.services.sync.syncOnce());
}

/**
 * The bodies of the `proposal` events a device has queued for `groupId`, in
 * its outbox or, once sent, in its log, in that order.
 */
async function queued(device: TestDevice | undefined, groupId: string) {
  const group = await device?.services.store.getGroup(groupId);
  const records = [...(group?.log ?? []).map((record) => record.bytes), ...(group?.outbox ?? [])];
  return records.flatMap((bytes) => {
    const event = parseRecord(bytes)?.event;
    return event?.type === 'proposal' ? [event.body] : [];
  });
}

/** Both devices score Proposal `id` 4, which closes it early, and both sync. */
async function passBoth(devices: readonly TestDevice[], groupId: string, id: string) {
  for (const device of devices) {
    await castBallot(device.services, groupId, { proposal: id, scores: { [id]: 4 }, note: '' });
    await sync(device);
  }
  for (const device of devices) await sync(device);
}

/** The sections a Document view shows, in order, by their text. */
function sectionsIn(app: HTMLElement): string[] {
  return Array.from(app.querySelectorAll('.document > .atom .atom-text')).map(
    (node) => node.textContent,
  );
}

// Two devices' apps take two Proposals through the composer and both ballots, about ten sync
// passes that sign, seal and open every record for real, and this file's one test also pays for
// compiling the app: about 2 s alone, 2.5-3.6 s at load 3-6.5, and past the default 5 s at load
// 11 (#260). Each step is awaited, so nothing races; the time is that work. The global
// timeouts stay as they are.
const TWO_PROPOSALS = { timeout: 10_000 };

describe('An outline in the app (#103)', () => {
  it(
    'queues a Section header’s add as “# Values\\n”, then moves a section first, and both devices read one order',
    TWO_PROPOSALS,
    async () => {
      const user = userEvent.setup(APP_USER);
      const fake = createFakeRelay();
      const { groupId, devices } = await members(fake, ['Ana', 'Ben']);
      opened.push(...devices);
      const [ana, ben] = devices;
      go(`#/g/${groupId}/doc/${groupId}`);
      const a = mount(ana, 'a');

      await user.click(
        await within(a).findByRole('button', { name: 'Add a section here, after section 1' }),
      );
      await user.click(
        await within(document.body).findByRole('menuitem', { name: 'Section header' }),
      );
      await waitFor(() => {
        expect(window.location.hash).toBe(`#/g/${groupId}/add-header/${groupId}.0`);
      });
      await user.click(await within(a).findByRole('textbox', { name: 'Heading' }));
      await user.paste('Values');
      expect(within(a).getByRole('textbox', { name: 'Title' })).toHaveValue(
        'Add section header: Values',
      );
      await user.click(within(a).getByRole('textbox', { name: 'Why' }));
      await user.paste('An outline first.');
      await user.click(within(a).getByRole('button', { name: 'Propose this header' }));
      await waitFor(async () => {
        expect(await queued(ana, groupId)).toEqual([
          {
            target: { kind: 'add', document: groupId, after: `${groupId}.0` },
            title: 'Add section header: Values',
            why: 'An outline first.',
            text: '# Values\n',
            window: 7,
          },
        ]);
      });
      const header = window.location.hash.split('/').at(-1) ?? '';
      await sync(ana);
      await passBoth(devices, groupId, header);

      go(`#/g/${groupId}/doc/${groupId}`);
      await within(a).findByRole('heading', { level: 2, name: 'Values' });
      expect(sectionsIn(a)).toEqual([
        'Quiet hours start at ten.',
        'Values',
        'Bins go out on Tuesday.',
      ]);
      await user.click(within(a).getByRole('button', { name: 'Move this section, section 2' }));
      await user.click(await within(a).findByRole('textbox', { name: 'Title' }));
      await user.paste('Values first');
      await user.click(within(a).getByRole('textbox', { name: 'Why' }));
      await user.paste('Lead with what we share.');
      await user.click(within(a).getByRole('radio', { name: 'Put it first' }));
      await user.click(within(a).getByRole('button', { name: 'Propose this move' }));
      await waitFor(async () => {
        expect((await queued(ana, groupId)).map((body) => 'target' in body && body.target)).toEqual(
          [
            { kind: 'add', document: groupId, after: `${groupId}.0` },
            { kind: 'move', atom: header, after: null },
          ],
        );
      });
      const move = window.location.hash.split('/').at(-1) ?? '';
      await sync(ana);
      await passBoth(devices, groupId, move);

      go(`#/g/${groupId}/doc/${groupId}`);
      const b = mount(ben, 'b');
      const order = ['Values', 'Quiet hours start at ten.', 'Bins go out on Tuesday.'];
      await waitFor(() => {
        expect(sectionsIn(a)).toEqual(order);
        expect(sectionsIn(b)).toEqual(order);
      });
      expect(b.querySelector('.document > .atom')).toHaveClass('atom-heading');
    },
  );
});
