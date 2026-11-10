/**
 * Several members' devices on one fake relay, set up through the app's own
 * actions (Create group, then Join from the founder's invite), for tests of
 * what comes after: proposing and voting.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { createGroup, joinGroup, lookupInvite, makeInvite } from '../app/actions';
import { App } from '../app/App';
import { parseInviteLink } from '../app/invite';
import type { AppServices } from '../app/services';
import { type Level, LEVELS } from '../engine/capabilities';
import { testDevice, type TestDevice } from './appServices';
import type { FakeRelay } from './fakeRelay';

/** A group founded by the first device and joined by the rest, all synced. */
export interface TestMembers {
  readonly groupId: string;
  readonly devices: readonly TestDevice[];
}

/** The founding Document: two sections. */
export const FOUNDING = {
  groupName: 'Riverside Tenants',
  title: 'House rules',
  text: 'Quiet hours start at ten.\n\nBins go out on Tuesday.',
};

/** The level the helpers join at unless a test names one: the creating level, so joiners can do all the founder can. */
const [, , CREATING] = LEVELS;

/**
 * Opens one device per name on `fake`; the first founds the group with `chat`,
 * the others join from its invite at `levels[name]` (a Co-Creator unless
 * named), and every device syncs.
 */
export async function members(
  fake: FakeRelay,
  names: readonly string[],
  chat: string | null = null,
  levels: Readonly<Record<string, Level>> = {},
): Promise<TestMembers> {
  const devices = await Promise.all(names.map((name) => testDevice(fake, name.toLowerCase())));
  const [founder, ...joiners] = devices;
  const [founderName = ''] = names;
  if (founder === undefined) throw new Error('A group needs a founder.');
  const created = await createGroup(founder.services, { ...FOUNDING, yourName: founderName, chat });
  if (created.outcome !== 'created') throw new Error('Expected a group.');
  const { groupId } = created;
  await founder.services.sync.syncOnce();
  for (const [index, device] of joiners.entries()) {
    const name = names[index + 1] ?? '';
    await joinFrom(founder, groupId, device, name, levels[name] ?? CREATING);
  }
  for (const device of devices) await device.services.sync.syncOnce();
  return { groupId, devices };
}

/** `device` joins `groupId` as `name`, at `level`, from a link `founder` makes, and syncs. */
async function joinFrom(
  founder: TestDevice,
  groupId: string,
  device: TestDevice,
  name: string,
  level: Level,
): Promise<void> {
  const { services } = founder;
  const seed = parseInviteLink(await makeInvite(services, groupId, services.origin));
  if (seed === null) throw new Error('Expected an invite link.');
  const found = await lookupInvite(device.services, seed);
  if (found.kind !== 'found') throw new Error('Expected the invite to open.');
  await joinGroup(device.services, found.group, name, level);
  await device.services.sync.syncOnce();
}

/** Opens a new device on `fake` and joins `groupId` as `name`, later than the others. */
export async function joinLater(
  fake: FakeRelay,
  founder: TestDevice,
  groupId: string,
  name: string,
  level: Level = CREATING,
): Promise<TestDevice> {
  const device = await testDevice(fake, name.toLowerCase());
  await joinFrom(founder, groupId, device, name, level);
  return device;
}

/** One device's app, mounted in its own container with its own React id prefix. */
export interface MountedApp {
  readonly container: HTMLElement;
  unmount(): void;
}

/**
 * Mounts `App` for one device beside others in the same document. Each root
 * gets its own `identifierPrefix`, so React Aria's ids never collide between
 * two devices' screens.
 */
export function mountApp(services: AppServices, prefix: string): MountedApp {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container, { identifierPrefix: `${prefix}-` });
  act(() => {
    root.render(<App services={services} />);
  });
  return {
    container,
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Moves every mounted app to `hash`, as the address bar would. */
export function go(hash: string): void {
  act(() => {
    window.history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

/** The queries `within(app)` returns, as far as these helpers use them. */
export interface AppQueries {
  findByRole(role: string, options: { name: string | RegExp }): Promise<HTMLElement>;
  getByRole(role: string, options: { name: string | RegExp }): HTMLElement;
}

/** The parts of a user-event session these helpers use. */
export interface Typist {
  click(element: Element): Promise<void>;
  clear(element: Element): Promise<void>;
  paste(text: string): Promise<void>;
}

/** What a test types into the composer. */
export interface ComposerEntries {
  readonly title: string;
  readonly why?: string;
  readonly text: string;
  readonly link?: string;
}

/** Proposes on section `section` from an app's Document view, through the composer. */
export async function proposeFrom(
  where: AppQueries,
  user: Typist,
  section: number,
  entries: ComposerEntries,
): Promise<void> {
  const name = `Propose a change to section ${String(section)}`;
  await user.click(await where.findByRole('button', { name }));
  const fields: [string, string][] = [
    ['Title', entries.title],
    ['Why', entries.why ?? 'Weekends run late.'],
    ['New text', entries.text],
  ];
  if (entries.link !== undefined) fields.push(['Discussion link (optional)', entries.link]);
  for (const [label, value] of fields) {
    const box = await where.findByRole('textbox', { name: label });
    await user.clear(box);
    await user.click(box);
    await user.paste(value);
  }
  await user.click(where.getByRole('button', { name: 'Propose this change' }));
}

/** Picks a score pill on an app's open ballot and sends the ballot. */
export async function score(where: AppQueries, user: Typist, pill: string): Promise<void> {
  await user.click(await where.findByRole('radio', { name: pill }));
  await user.click(where.getByRole('button', { name: /your vote$/ }));
}
