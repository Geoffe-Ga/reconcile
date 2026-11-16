/**
 * Protecting sections through the whole app (#116), on two devices that share
 * one fake relay. Ana entrenches the first section from Protect this section,
 * then makes it eternal from Change its protection. Each class Proposal
 * queues `{kind: "class", atom, to}` with the entrenched default window, and
 * both pass. Both devices then read the section as eternal, with no action on
 * it but its History (#104), and Propose a change's route says it can't be
 * changed.
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

/** The targets of the `proposal` events a device has queued for `groupId`, in its log, then its outbox. */
async function targets(device: TestDevice | undefined, groupId: string) {
  const group = await device?.services.store.getGroup(groupId);
  const records = [...(group?.log ?? []).map((record) => record.bytes), ...(group?.outbox ?? [])];
  return records.flatMap((bytes) => {
    const event = parseRecord(bytes)?.event;
    if (event?.type !== 'proposal') return [];
    const { body } = event;
    if (!('target' in body)) return [];
    return [{ target: body.target, window: 'window' in body ? body.window : undefined }];
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

/** Fills Protect this section's title and why, picks `choice` and presses `submit`. */
async function propose(app: HTMLElement, choice: string, submit: string) {
  const user = userEvent.setup(APP_USER);
  await user.click(await within(app).findByRole('textbox', { name: 'Title' }));
  await user.paste('Keep quiet hours');
  await user.click(within(app).getByRole('textbox', { name: 'Why' }));
  await user.paste('They hold us together.');
  await user.click(within(app).getByRole('radio', { name: choice }));
  await user.click(within(app).getByRole('button', { name: submit }));
}

// Two devices' apps take two class Proposals through the composer and both ballots, about ten
// sync passes that sign, seal and open every record for real, and this file's one test also
// pays for compiling the app: about 2 s alone, and past the default 5 s at load 11 (#260). Each
// step is awaited, so nothing races; the time is that work. The global timeouts stay as they
// are.
const TWO_PROPOSALS = { timeout: 10_000 };

describe('Protecting a section in the app (#116)', () => {
  it(
    'entrenches a section, then makes it eternal, and both devices read it as eternal, with nothing to change',
    TWO_PROPOSALS,
    async () => {
      const user = userEvent.setup(APP_USER);
      const fake = createFakeRelay();
      const { groupId, devices } = await members(fake, ['Ana', 'Ben']);
      opened.push(...devices);
      const [ana, ben] = devices;
      const first = `${groupId}.0`;
      go(`#/g/${groupId}/doc/${groupId}`);
      const a = mount(ana, 'a');

      await user.click(
        await within(a).findByRole('button', { name: 'Protect this section, section 1' }),
      );
      await waitFor(() => {
        expect(window.location.hash).toBe(`#/g/${groupId}/protect/${first}`);
      });
      expect(await within(a).findByRole('textbox', { name: 'Voting time (days)' })).toHaveValue(
        '14',
      );
      await propose(a, 'Entrenched', 'Propose this protection');
      await waitFor(async () => {
        expect(await targets(ana, groupId)).toEqual([
          { target: { kind: 'class', atom: first, to: 'entrenched' }, window: 14 },
        ]);
      });
      const entrench = window.location.hash.split('/').at(-1) ?? '';
      await sync(ana);
      await passBoth(devices, groupId, entrench);

      go(`#/g/${groupId}/doc/${groupId}`);
      expect(await within(a).findByText('Entrenched')).toHaveClass('atom-badge-entrenched');
      await user.click(within(a).getByRole('button', { name: 'Change its protection, section 1' }));
      await within(a).findByRole('heading', { level: 1, name: 'Change this section’s protection' });
      await propose(a, 'Make it eternal', 'Propose this change');
      await waitFor(async () => {
        expect((await targets(ana, groupId)).map(({ target }) => target)).toEqual([
          { kind: 'class', atom: first, to: 'entrenched' },
          { kind: 'class', atom: first, to: 'eternal' },
        ]);
      });
      const eternal = window.location.hash.split('/').at(-1) ?? '';
      await sync(ana);
      await passBoth(devices, groupId, eternal);

      go(`#/g/${groupId}/doc/${groupId}`);
      const b = mount(ben, 'b');
      for (const app of [a, b]) {
        const section = await waitFor(() => {
          const atom = app.querySelector('.document > .atom');
          expect(atom?.querySelector('.atom-badge')).toHaveTextContent('Eternal');
          return atom as HTMLElement;
        });
        // Only its History stays, as on every section (#104).
        expect(
          within(section)
            .getAllByRole('button')
            .map((button) => button.getAttribute('aria-label')),
        ).toEqual(['History of section 1']);
        expect(
          within(section).getByText('This section is eternal. It can’t be changed.'),
        ).toBeVisible();
      }
      go(`#/g/${groupId}/propose/${first}`);
      expect(
        await within(a).findByRole('heading', { level: 1, name: 'This section is eternal' }),
      ).toBeVisible();
    },
  );
});
