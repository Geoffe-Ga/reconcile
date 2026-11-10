import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import {
  createGroup,
  type FoundGroup,
  type InviteLookup,
  joinGroup,
  makeInvite,
} from '../app/actions';
import { App } from '../app/App';
import { parseInviteLink } from '../app/invite';
import { messages } from '../app/messages';
import { navigate } from '../app/router';
import { newGroupSecret } from '../crypto/groupKeys';
import { inviteChannelOf, newInviteSeed } from '../crypto/invite';
import type * as SignModule from '../crypto/sign';
import { newSigningKeys } from '../crypto/sign';
import { DEFAULT_JOIN_LEVEL, type Level, LEVELS } from '../engine/capabilities';
import { base64url } from '../engine/event';
import type { LogRecord } from '../engine/fold';
import { type TestDevice, testDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { testGroup } from '../test/groups';
import { freshIndexedDBPerTest } from '../test/idb';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { Join } from './Join';

vi.mock('../crypto/sign', async (importOriginal) => {
  const actual = await importOriginal<typeof SignModule>();
  return { ...actual, newSigningKeys: vi.fn(actual.newSigningKeys) };
});

freshIndexedDBPerTest();

const keysMade = vi.mocked(newSigningKeys);
const devices: TestDevice[] = [];

const PREVIEW = {
  groupName: 'Riverside Tenants',
  inviterName: 'Ana',
  documentTitle: 'House rules',
  excerpt: 'Quiet hours start at ten.',
};

const FOUND: FoundGroup = {
  groupId: 'group-1',
  preview: PREVIEW,
  secret: newGroupSecret(),
  token: { by: 'a'.repeat(43), sig: 'b'.repeat(86) },
  page: { records: testGroup().records, cursor: 1, relayNow: 29_000_100, instance: 'relay' },
};

afterEach(() => {
  for (const device of devices.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
  window.localStorage.clear();
  keysMade.mockClear();
  vi.restoreAllMocks();
});

type Lookup = (seed: Uint8Array) => Promise<InviteLookup>;

interface Options {
  readonly payload?: string | null;
  readonly heldSeed?: Uint8Array | null;
  readonly lookup?: Lookup;
  readonly joined?: boolean;
}

function setup(options: Options = {}) {
  const seed = newInviteSeed();
  const payload = options.payload === undefined ? base64url(seed) : options.payload;
  if (payload !== null) window.history.replaceState(null, '', `#join/${payload}`);
  const found = (): Promise<InviteLookup> => Promise.resolve({ kind: 'found', group: FOUND });
  const lookup = vi.fn<Lookup>(options.lookup ?? found);
  const onJoin = vi.fn(() => Promise.resolve(options.joined ?? true));
  const onNotNow = vi.fn();
  const { rerender } = render(
    <Join
      payload={payload}
      heldSeed={options.heldSeed ?? null}
      lookup={lookup}
      onJoin={onJoin}
      onNotNow={onNotNow}
    />,
  );
  return { user: userEvent.setup(), seed, payload, lookup, onJoin, onNotNow, rerender };
}

describe('Join', () => {
  it('takes the seed out of the address bar as soon as it has read it', () => {
    setup();
    expect(window.location.hash).toBe('#/join');
  });

  it('shows the preview from the inviter, then asks for a name, saying who will see it', async () => {
    const { seed, lookup } = setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Opening the invite…' })).toBeVisible();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(Array.from(lookup.mock.calls[0]?.[0] ?? [])).toEqual(Array.from(seed));
    expect(screen.getByText(/^From/)).toHaveTextContent('From Ana’s invite');
    expect(screen.getByText('House rules')).toBeVisible();
    expect(screen.getByText('Quiet hours start at ten.')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Your name' })).toHaveAccessibleDescription(
      'This name is only shown in this group. It doesn’t have to be your real name.',
    );
    expect(
      screen.getByText('People in this group will see the name you choose and how you vote.'),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('joins under the name given, trimmed, as a Collaborator unless they choose otherwise', async () => {
    const { user, onJoin } = setup();
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), '  Ben ');
    expect(screen.getByRole('radio', { name: 'Collaborator' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    expect(onJoin).toHaveBeenCalledWith(FOUND, 'Ben', DEFAULT_JOIN_LEVEL);
  });

  it.each([
    ['Member', 0],
    ['Co-Creator', 2],
  ] as const)('joins as a %s when they choose it', async (name, index) => {
    const { user, onJoin } = setup();
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ben');
    await user.click(screen.getByRole('radio', { name }));
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    expect(onJoin).toHaveBeenCalledExactlyOnceWith(FOUND, 'Ben', LEVELS[index]);
  });

  it('asks how involved they want to be, after their name and before who sees it', async () => {
    setup();
    const name = await screen.findByRole('textbox', { name: 'Your name' });
    const picker = screen.getByRole('radiogroup', { name: 'Your involvement' });
    const visibility = screen.getByText(
      'People in this group will see the name you choose and how you vote.',
    );
    expect(name.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      picker.compareDocumentPosition(visibility) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(picker).getAllByRole('radio')).toHaveLength(3);
    expect(await axeViolations()).toEqual([]);
  });

  it('joins once, however often the button is pressed while it works', async () => {
    const user = userEvent.setup();
    let finish: (joined: boolean) => void = () => undefined;
    const onJoin = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    window.history.replaceState(null, '', '#/join');
    render(
      <Join
        payload={null}
        heldSeed={newInviteSeed()}
        lookup={() => Promise.resolve({ kind: 'found', group: FOUND })}
        onJoin={onJoin}
        onNotNow={vi.fn()}
      />,
    );
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ben');
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    finish(false);
    await screen.findByRole('alert');
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('ignores Not now while a join is under way, and takes it once that join didn’t finish', async () => {
    const user = userEvent.setup();
    let finish: (joined: boolean) => void = () => undefined;
    const onJoin = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const onNotNow = vi.fn();
    window.history.replaceState(null, '', '#/join');
    render(
      <Join
        payload={null}
        heldSeed={newInviteSeed()}
        lookup={() => Promise.resolve({ kind: 'found', group: FOUND })}
        onJoin={onJoin}
        onNotNow={onNotNow}
      />,
    );
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ben');
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onNotNow).not.toHaveBeenCalled();
    finish(false);
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onNotNow).toHaveBeenCalledTimes(1);
  });

  it('asks for a name before joining', async () => {
    const { user, onJoin } = setup();
    const name = await screen.findByRole('textbox', { name: 'Your name' });
    await user.type(name, '   ');
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    expect(onJoin).not.toHaveBeenCalled();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveFocus();
    expect(await axeViolations()).toEqual([]);
  });

  it('says so when joining doesn’t finish', async () => {
    const { user } = setup({ joined: false });
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ben');
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Joining didn’t finish. Try again.');
  });

  it.each([
    ['a damaged link', 'not-an-invite.payload'],
    ['a seed cut short', 'not-an-invite'.padEnd(42, 'A')],
    ['a seed with stray bits', `not-an-invite${'A'.repeat(29)}B`],
    ['no link at all', null],
  ])('refuses %s plainly, without fetching or repeating it', async (_label, payload) => {
    const { lookup } = setup({ payload });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This invite link doesn’t work' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        'This invite link has expired or is damaged. Ask someone in your group for a new one.',
      ),
    ).toBeVisible();
    expect(lookup).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent('not-an-invite');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Your groups' })).toHaveAttribute('href', '#/');
    expect(await axeViolations()).toEqual([]);
  });

  it('refuses an expired or damaged envelope with the same line, and no name field', async () => {
    setup({ lookup: () => Promise.resolve({ kind: 'missing' }) });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This invite link doesn’t work' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('offers to try again when the relay is out of reach', async () => {
    let calls = 0;
    const { user, lookup } = setup({
      lookup: () =>
        Promise.resolve(calls++ === 0 ? { kind: 'offline' } : { kind: 'found', group: FOUND }),
    });
    expect(
      await screen.findByText(
        'Can’t reach the relay right now. Check your connection, then try again.',
      ),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('treats a failed lookup as out of reach', async () => {
    setup({ lookup: () => Promise.reject(new Error('boom')) });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('points a member to their group instead of joining twice', async () => {
    setup({ lookup: () => Promise.resolve({ kind: 'joined', groupId: 'group-1' }) });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'You’re already in this group' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        'This invite is for a group you’re already in on this device. Anything this device was missing from its history is here now.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open your group' })).toHaveAttribute(
      'href',
      '#/g/group-1',
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('opens a new invite that arrives while Join is showing', async () => {
    const { lookup, onJoin, onNotNow, rerender } = setup({ payload: 'damaged' });
    expect(screen.getByRole('heading', { name: 'This invite link doesn’t work' })).toBeVisible();
    const next = newInviteSeed();

    rerender(
      <Join
        payload={base64url(next)}
        heldSeed={null}
        lookup={lookup}
        onJoin={onJoin}
        onNotNow={onNotNow}
      />,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(Array.from(lookup.mock.calls[0]?.[0] ?? [])).toEqual(Array.from(next));
  });

  it('reads the mailbox once per invite, even when handed a new lookup function', async () => {
    const { lookup, onJoin, onNotNow, rerender } = setup();
    await screen.findByRole('textbox', { name: 'Your name' });
    const next = vi.fn(() => Promise.resolve<InviteLookup>({ kind: 'missing' }));

    rerender(
      <Join payload={null} heldSeed={null} lookup={next} onJoin={onJoin} onNotNow={onNotNow} />,
    );
    await screen.findByRole('textbox', { name: 'Your name' });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('shows a preview’s markup and script-like text as the plain text it is', async () => {
    const preview = {
      groupName: '<img src=x onerror="alert(1)">',
      inviterName: '**Ana**',
      documentTitle: '<script>alert(1)</script>',
      excerpt: '[x](javascript:alert(1)) <b>bold</b>',
    };
    const group = { ...FOUND, preview };
    setup({ lookup: () => Promise.resolve({ kind: 'found', group }) });

    expect(await screen.findByRole('heading', { level: 1, name: preview.groupName })).toBeVisible();
    expect(screen.getByText(/^From/)).toHaveTextContent(`From **Ana**’s invite`);
    expect(screen.getByRole('heading', { level: 2, name: preview.documentTitle })).toBeVisible();
    // The whole Document takes the excerpt's place under the title (#91).
    expect(screen.queryByText(preview.excerpt)).not.toBeInTheDocument();
    expect(document.querySelector('main img, main script, main b, main strong')).toBeNull();
    expect(document.querySelector('main a[href^="javascript"]')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('opens an invite pasted on Start, which never touched the address bar', async () => {
    const held = newInviteSeed();
    const { lookup } = setup({ payload: null, heldSeed: held });
    await waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(1);
    });
    expect(lookup.mock.calls[0]?.[0]).toBe(held);
    expect(window.location.hash).toBe('#/');
  });
});

const EARLY = 'Quiet after 10pm.';
const LATE = 'Bins go out on Monday.';

/**
 * Ana, Ben, Cal and Dee. The first section's edit passed by early close, once
 * all four scored it; the second's has the quorum's three scores, so it
 * passes only when relay time reaches its deadline.
 */
function passedTwice(): { readonly records: readonly LogRecord[]; readonly deadline: number } {
  const log = groupLog({ members: ['Ben', 'Cal', 'Dee'] });
  const early = log.propose('Ana', { atom: 0, text: EARLY });
  for (const name of ['Ana', 'Ben', 'Cal', 'Dee']) log.vote(name, early, 4);
  const late = log.propose('Ana', { atom: 1, text: LATE });
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, late, 4);
  return { records: log.records, deadline: deadlineOf(START_MINUTE) };
}

/** FOUND, carrying `records`, read by an invite GET whose `now` was `relayNow`. */
function carrying(records: readonly LogRecord[], relayNow = FOUND.page.relayNow): FoundGroup {
  return { ...FOUND, page: { ...FOUND.page, records, relayNow } };
}

const found = (group: FoundGroup) => () => Promise.resolve<InviteLookup>({ kind: 'found', group });

/** Every write a page could make to IndexedDB, each spied on. */
function spyOnWrites(): MockInstance[] {
  const proto = IDBObjectStore.prototype;
  return [
    vi.spyOn(proto, 'put'),
    vi.spyOn(proto, 'add'),
    vi.spyOn(proto, 'delete'),
    vi.spyOn(proto, 'clear'),
  ];
}

const writes = (spies: readonly MockInstance[]) =>
  spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);

/** True when each element comes after the one before it in the page. */
function inOrder(elements: readonly Element[]): boolean {
  return elements.every(
    (element, i) =>
      i === 0 ||
      (elements[i - 1]?.compareDocumentPosition(element) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

async function device(fake: FakeRelay, name: string): Promise<TestDevice> {
  const opened = await testDevice(fake, name);
  devices.push(opened);
  return opened;
}

describe('Join, reading the Document before joining (#91)', () => {
  it('reads the preview card, the whole Document as it reads now, then asks to join', async () => {
    const { records, deadline } = passedTwice();
    const { user, onJoin, onNotNow } = setup({ lookup: found(carrying(records, deadline)) });

    const group = await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    const heading = screen.getByRole('heading', { level: 2, name: 'House rules' });
    expect(heading).toHaveFocus();
    const article = screen.getByRole('article');
    // Both passes show: one closed early, the other at the deadline the invite GET's now reached.
    expect(
      within(article)
        .getAllByRole('paragraph')
        .map((p) => p.textContent),
    ).toEqual([EARLY, LATE]);
    const question = screen.getByRole('heading', {
      level: 2,
      name: 'Do you share enough of this to join?',
    });
    const notNow = screen.getByRole('button', { name: 'Not now' });
    const page = [
      group,
      screen.getByText(/^From/),
      heading,
      article,
      question,
      screen.getByRole('textbox', { name: 'Your name' }),
      screen.getByRole('radiogroup', { name: 'Your involvement' }),
      screen.getByRole('button', { name: 'Join group' }),
      notNow,
    ];
    expect(inOrder(page)).toBe(true);
    expect(notNow).toHaveAccessibleDescription('You can open the link again while it lasts.');
    expect(await axeViolations()).toEqual([]);

    await user.click(notNow);
    expect(onNotNow).toHaveBeenCalledTimes(1);
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('stores nothing and makes no key until Join is tapped, then joins with what it showed', async () => {
    const ben = await device(createFakeRelay(), 'ben');
    const spies = spyOnWrites();
    const { records, deadline } = passedTwice();
    const group = carrying(records, deadline);
    const onJoin = vi.fn(async (joining: FoundGroup, name: string, level: Level) => {
      await joinGroup(ben.services, joining, name, level);
      return true;
    });
    const user = userEvent.setup();
    render(
      <Join
        payload={null}
        heldSeed={newInviteSeed()}
        lookup={found(group)}
        onJoin={onJoin}
        onNotNow={vi.fn()}
      />,
    );

    expect(await screen.findByText(LATE)).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Eve');
    await user.click(screen.getByRole('radio', { name: 'Member' }));
    expect(writes(spies)).toBe(0);
    expect(keysMade).not.toHaveBeenCalled();
    expect(await ben.services.store.listGroups()).toEqual([]);
    expect(window.localStorage).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Join group' }));
    await waitFor(() => {
      expect(onJoin).toHaveBeenCalledExactlyOnceWith(group, 'Eve', LEVELS[0]);
    });
    await waitFor(async () => {
      expect(await ben.services.store.listGroups()).toHaveLength(1);
    });
    expect(keysMade).toHaveBeenCalledTimes(1);
    expect(writes(spies)).toBeGreaterThan(0);
  });

  it('renders an Atom’s markup inert: no live javascript: link, script or image', async () => {
    const atoms = [
      '[x](javascript:alert(1))',
      '<img src=x onerror="alert(1)"> <a href="javascript:alert(1)">raw</a>',
      '<script>alert(1)</script>',
    ];
    setup({ lookup: found(carrying(testGroup({ atoms }).records)) });

    const article = await screen.findByRole('article');
    expect(article).toHaveTextContent('[x](javascript:alert(1))');
    expect(article).toHaveTextContent('<script>alert(1)</script>');
    expect(document.querySelector('a[href^="javascript" i], script, img, [onerror]')).toBeNull();
    expect(within(article).queryByRole('link')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('passes axe with a long Document of headings and lists', async () => {
    const atoms = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0
        ? `# Part ${String(i + 1)}\nWhat part ${String(i + 1)} says, at reading length, wraps onto a second line.`
        : `- One thing for part ${String(i + 1)}\n- Another thing\n  - and a detail`,
    );
    setup({ lookup: found(carrying(testGroup({ atoms }).records)) });
    const article = await screen.findByRole('article');
    expect(within(article).getAllByRole('heading', { level: 2 })).toHaveLength(15);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the expired-or-damaged line when the entries hold no genesis', async () => {
    const { onNotNow } = setup({ lookup: found(carrying([])) });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This invite link doesn’t work' }),
    ).toBeVisible();
    expect(screen.getByText(messages.join.badLink)).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(onNotNow).not.toHaveBeenCalled();
  });
});

describe('Not now, in the app (#91)', () => {
  it('returns to Start and lets go of the invite, writing nothing, with no request beyond the invite GET', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const created = await createGroup(ana.services, {
      groupName: 'Riverside Tenants',
      yourName: 'Ana',
      chat: null,
      title: 'House rules',
      text: 'Quiet hours start at ten.\n\nBins go out on Tuesday.',
    });
    if (created.outcome !== 'created') throw new Error('Expected a group.');
    await ana.services.sync.syncOnce();
    const link = await makeInvite(ana.services, created.groupId, ana.services.origin);
    const seed = parseInviteLink(link);
    if (seed === null) throw new Error('Expected an invite link.');
    const ben = await device(fake, 'ben');
    const before = fake.requests.length;
    keysMade.mockClear();
    const spies = spyOnWrites();

    // Pasted on Start, the seed travels to Join in memory, held by the app.
    render(<App services={ben.services} />);
    await user.click(await screen.findByRole('textbox', { name: 'Invite link' }));
    await user.paste(link);
    await user.click(screen.getByRole('button', { name: 'Join with an invite link' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'House rules' })).toHaveFocus();
    expect(screen.getByText('Bins go out on Tuesday.')).toBeVisible();
    const inviteGet = [['GET', inviteChannelOf(seed).mailbox]];
    const sent = () =>
      fake.requests
        .slice(before)
        .map((request) => [request.method, request.url.split('/').at(-1)?.split('?')[0]]);
    expect(sent()).toEqual(inviteGet);

    await user.click(screen.getByRole('button', { name: 'Not now' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Your groups' })).toBeVisible();
    expect(window.location.hash).toBe('#/');
    expect(await ben.services.store.listGroups()).toEqual([]);
    expect(writes(spies)).toBe(0);
    expect(keysMade).not.toHaveBeenCalled();
    expect(window.localStorage).toHaveLength(0);

    // The held seed is gone from memory: Join with no link in hand shows the damaged line.
    act(() => {
      navigate({ name: 'join', payload: null });
    });
    expect(await screen.findByText(messages.join.badLink)).toBeVisible();
    expect(sent()).toEqual(inviteGet);
  });
});
