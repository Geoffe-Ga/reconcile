import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { CoalitionHomeView, MotionItem } from '../app/coalitionHome';
import { formatDay } from '../app/format';
import { messages } from '../app/messages';
import type { WebShare } from '../app/share';
import { RESULT_GRACE_MINUTES } from '../engine/coalition';
import type { CoalitionProgress } from '../engine/coalitionProgress';
import { newestFirst } from '../engine/dispatches';
import { fold } from '../engine/fold';
import { DAY_MINUTES } from '../engine/rules';
import { axeViolations } from '../test/axe';
import { Logs, seatKey } from '../test/coalitions';
import { CoalitionHome, type CoalitionHomeProps } from './CoalitionHome';

const NOW = 29_400_000;

const OPEN: CoalitionProgress = {
  seats: 2,
  passed: 1,
  failed: 0,
  needed: 2,
  deciding: ['Oak St Co-op'],
  groups: [],
  final: false,
  settles: NOW + 20_000,
};

/** A motion on the coalition home, open unless `progress` says otherwise. */
function motion(id: string, overrides: Partial<MotionItem> = {}): MotionItem {
  return {
    id,
    title: 'Paths too',
    deadline: NOW + 5_000,
    closedAt: null,
    decidedAt: NOW + 15_000,
    progress: OPEN,
    groupId: 'riverside',
    ...overrides,
  };
}

const VIEW: CoalitionHomeView = {
  coalitionId: 'coalition-1',
  entryId: 'entry-1',
  name: 'Eastside Housing',
  members: [
    { name: 'Riverside Tenants', mine: true, coalition: false },
    { name: 'Oak St Co-op', mine: false, coalition: false },
  ],
  documents: [{ id: 'coalition-1', title: 'Mission statement' }],
  open: [motion('m1')],
  decided: [],
  pending: [],
  standing: { kind: 'proposes', groupId: 'riverside' },
  dispatches: [],
  follower: false,
  share: false,
  room: true,
};

/**
 * A formed coalition whose one motion carried a Dispatch with `<b>` in its
 * words, folded once that pass is final (#124), so it has gone out.
 */
function coalitionWithDispatch() {
  const logs = new Logs();
  const at = logs.formed(29_375_010, ['A', 'B'], ['kim', 'zed']);
  const motion = logs.motion(at, 'kim', 'Banks too.', {
    title: 'Updated: <b>Mission statement</b>',
    text: 'We keep the banks clean.\nSee you Sunday.',
  });
  logs.result(at + 1, 'kim', motion, 'A', 'pass');
  logs.result(at + 2, 'zed', motion, 'B', 'pass');
  const state = fold(logs.logs.coalition ?? [], at + 7 * DAY_MINUTES + RESULT_GRACE_MINUTES);
  const id = state.group ?? '';
  return { state, id, dispatches: newestFirst(state) };
}

const { state: STATE } = coalitionWithDispatch();

function props(overrides: Partial<CoalitionHomeProps> = {}): CoalitionHomeProps {
  return {
    view: VIEW,
    state: STATE,
    now: NOW,
    back: { groupId: 'riverside', name: 'Riverside Tenants' },
    onTakePart: vi.fn(() => Promise.resolve()),
    makeFollowLink: vi.fn(() => Promise.resolve('https://reconcile.test/#follow/abc')),
    copyText: vi.fn(() => Promise.resolve()),
    sharing: { share: undefined },
    onUnfollow: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

const region = (name: string) => screen.getByRole('region', { name });

describe('CoalitionHome, with a coalition among its members (#122)', () => {
  it('marks a member coalition, and says Your coalition for one this device takes part through', async () => {
    const members = [
      { name: 'Eastside Housing', mine: true, coalition: true },
      { name: 'Hill Coalition', mine: false, coalition: true },
      { name: 'Elm Row', mine: false, coalition: false },
    ];
    render(<CoalitionHome {...props({ view: { ...VIEW, name: 'Metro Renters', members } })} />);
    const list = screen.getByRole('region', { name: messages.coalitions.groups });
    const [eastside, hill, elm] = within(list).getAllByRole('listitem');
    expect(eastside).toHaveTextContent(`Eastside Housing${messages.coalitions.yourCoalition}`);
    expect(hill).toHaveTextContent(`Hill Coalition${messages.coalitions.coalitionSeat}`);
    expect(elm).toHaveTextContent(/^Elm Row$/);
    expect(await axeViolations()).toEqual([]);
  });
});

/**
 * A formed coalition of Riverside Tenants and Oak St Co-op that passed
 * Riverside's Dispatch as it rose (#126), its pass final, as the coalition's
 * fold sends it out.
 */
function coalitionWithRisen() {
  const logs = new Logs();
  const at = logs.formed(29_375_010, ['Riverside Tenants', 'Oak St Co-op'], ['kim', 'zed']);
  const words = { title: 'Rally Saturday', text: 'Meet at the river at ten.\nBring water.' };
  const target = {
    kind: 'promote',
    dispatch: { id: 'riverside-dispatch', ...words },
    ceiling: 'coalitions',
    level: 1,
    from: seatKey('Riverside Tenants'),
  } as const;
  const risen = logs.promoteIn('coalition', at, 'kim', { target, title: words.title, why: '' });
  logs.result(at + 1, 'kim', risen, 'Riverside Tenants', 'pass');
  logs.result(at + 2, 'zed', risen, 'Oak St Co-op', 'pass');
  const state = fold(logs.logs.coalition ?? [], at + 7 * DAY_MINUTES + RESULT_GRACE_MINUTES);
  return { state, dispatches: newestFirst(state) };
}

describe('CoalitionHome’s Dispatches (#126)', () => {
  it('lists a Dispatch the coalition passed as it rose, from the seat that passed it below', async () => {
    const { state, dispatches } = coalitionWithRisen();
    render(<CoalitionHome {...props({ view: { ...VIEW, dispatches }, state })} />);
    const list = region(messages.dispatches.title);
    const [card, ...more] = within(list).getAllByRole('article');
    if (card === undefined) throw new Error('Expected the risen Dispatch’s card.');
    expect(more).toEqual([]);
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent('Rally Saturday');
    const received = dispatches[0]?.received ?? 0;
    expect(card).toHaveTextContent(`From Riverside Tenants,·${formatDay(received)}`);
    expect(within(card).getByText(/Meet at the river/).textContent).toBe(
      'Meet at the river at ten.\nBring water.',
    );
    // It points to no Document: a Document link stays in the group it started in.
    expect(within(card).queryByRole('link')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('says there are none yet', () => {
    render(<CoalitionHome {...props()} />);
    expect(region(messages.dispatches.title)).toHaveTextContent(messages.dispatches.empty);
  });
});

describe('CoalitionHome', () => {
  it('opens the room for a device in a member group, and shows no room otherwise (#125)', async () => {
    const { unmount } = render(<CoalitionHome {...props()} />);
    const room = within(region('Room')).getByRole('link', { name: /Open the room/ });
    expect(room).toHaveAttribute('href', '#/c/coalition-1/room');
    expect(region('Room')).toHaveTextContent(messages.room.homeLine);
    expect(await axeViolations()).toEqual([]);
    unmount();

    render(<CoalitionHome {...props({ view: { ...VIEW, room: false } })} />);
    expect(screen.queryByRole('region', { name: 'Room' })).toBeNull();
    expect(screen.queryByRole('link', { name: /room/i })).toBeNull();
  });

  it('names the coalition and lists its open Proposals, Documents, Decided and member groups', async () => {
    render(<CoalitionHome {...props()} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Eastside Housing' })).toBeVisible();
    expect(document.title).toBe('Coalition · Reconcile');
    const back = screen.getByRole('link', { name: /Riverside Tenants/ });
    expect(back).toHaveAttribute('href', '#/g/riverside');

    const open = within(region('Open Proposals')).getByRole('link', { name: /Paths too/ });
    expect(open).toHaveAttribute('href', '#/g/riverside/p/m1');
    expect(open).toHaveTextContent('1 of 2 groups has passed. Waiting for Oak St Co-op.');
    expect(open).toHaveTextContent('Closes in 3 days');

    const documents = within(region('Documents')).getByRole('link', { name: /Mission statement/ });
    expect(documents).toHaveAttribute('href', '#/c/coalition-1/doc/coalition-1');
    expect(region('Decided')).toHaveTextContent(messages.decided.empty);

    const groups = within(region('Member groups')).getAllByRole('listitem');
    expect(groups.map((item) => item.textContent)).toEqual([
      'Riverside TenantsYour group',
      'Oak St Co-op',
    ]);
    expect(screen.queryByRole('region', { name: 'Take part' })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('lists decided motions with whether the coalition passed them and the day it decided', () => {
    const passed = motion('m2', {
      title: 'Banks too',
      progress: { ...OPEN, passed: 2, deciding: [], outcome: 'pass', final: true },
    });
    const failed = motion('m3', {
      title: 'Bridges too',
      groupId: null,
      decidedAt: NOW - 1_440,
      progress: { ...OPEN, failed: 1, deciding: [], outcome: 'fail', final: true },
    });
    render(
      <CoalitionHome {...props({ view: { ...VIEW, open: [], decided: [passed, failed] } })} />,
    );

    const decided = region('Decided');
    const link = within(decided).getByRole('link', { name: /Banks too/ });
    expect(link).toHaveTextContent(`Passed${formatDay(NOW + 15_000)}`);
    // A motion no group on this device decides has no vote to open here.
    expect(within(decided).queryByRole('link', { name: /Bridges too/ })).not.toBeInTheDocument();
    expect(decided).toHaveTextContent(`Bridges tooDidn’t pass${formatDay(NOW - 1_440)}`);
    expect(region('Open Proposals')).toHaveTextContent(messages.coalitions.noOpen);
  });

  it('gives a decided motion’s outcome sentence in place of its countdown, while it waits to be final', () => {
    const passed = motion('m4', {
      progress: { ...OPEN, passed: 2, deciding: [], outcome: 'pass', final: false },
    });
    render(<CoalitionHome {...props({ view: { ...VIEW, open: [passed] } })} />);
    const card = within(region('Open Proposals')).getByRole('link', { name: /Paths too/ });
    expect(card).toHaveTextContent('The coalition passed this. It takes effect on');
    expect(card).not.toHaveTextContent('Closes');
  });

  it('lists a Proposal this device sent while it waits for the relay', () => {
    const view = { ...VIEW, open: [], pending: [{ id: 'p1', title: 'Paths too' }] };
    render(<CoalitionHome {...props({ view })} />);
    expect(region('Open Proposals')).toHaveTextContent(`Paths too${messages.coalitions.pending}`);
  });

  it('offers Take part first to someone who may propose in a member group and hasn’t joined', async () => {
    const user = userEvent.setup();
    const onTakePart = vi.fn(() => Promise.resolve());
    const view: CoalitionHomeView = { ...VIEW, standing: { kind: 'take-part', groupId: 'r' } };
    render(<CoalitionHome {...props({ view, onTakePart, back: null })} />);

    expect(screen.getByRole('link', { name: /Your groups/ })).toHaveAttribute('href', '#/');
    const takePart = region('Take part');
    expect(takePart).toHaveTextContent(messages.coalitions.takePartFirst);
    await user.type(within(takePart).getByRole('textbox'), 'Ana E.');
    await user.click(within(takePart).getByRole('button', { name: 'Take part' }));
    expect(onTakePart).toHaveBeenCalledWith('Ana E.');
    expect(await axeViolations()).toEqual([]);
  });

  it('lists the coalition’s Dispatches for a participant too, and offers no follow link unless bound', () => {
    const { state, id, dispatches } = coalitionWithDispatch();
    const view = { ...VIEW, coalitionId: id, documents: state.documents, dispatches };
    render(<CoalitionHome {...props({ view, state })} />);

    const card = within(region('Dispatches')).getByRole('article');
    expect(card).toHaveTextContent('Updated: <b>Mission statement</b>');
    expect(card).toHaveTextContent('From the Proposal ‘Banks too’');
    // The motion's vote lives inside each member group, so its title isn't a link here.
    expect(within(card).queryByRole('link', { name: 'Banks too' })).not.toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /Open/ })).toHaveAttribute(
      'href',
      `#/c/${id}/doc/${id}`,
    );
    expect(screen.queryByRole('region', { name: 'Followers' })).not.toBeInTheDocument();
  });

  it('lets a participant bound to a seat share a follow link, its warning beside it', async () => {
    const user = userEvent.setup();
    const makeFollowLink = vi.fn(() => Promise.resolve('https://reconcile.test/#follow/abc'));
    const copyText = vi.fn((text: string | Promise<string>) =>
      Promise.resolve(text).then(() => undefined),
    );
    render(
      <CoalitionHome {...props({ view: { ...VIEW, share: true }, makeFollowLink, copyText })} />,
    );

    const followers = region('Followers');
    expect(followers).toHaveTextContent(messages.coalitions.shareWarning);
    const button = within(followers).getByRole('button', { name: 'Share a follow link' });
    expect(button).toHaveAccessibleDescription(messages.coalitions.shareWarning);
    await user.click(button);

    expect(makeFollowLink).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(await within(followers).findByRole('textbox', { name: 'Follow link' })).toHaveValue(
      'https://reconcile.test/#follow/abc',
    );
    expect(within(followers).getByRole('status')).toHaveTextContent(
      messages.coalitions.shareCopied,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('puts Share beside Share a follow link, handing the share sheet a new link alone (#424)', async () => {
    const user = userEvent.setup();
    const makeFollowLink = vi.fn(() => Promise.resolve('https://reconcile.test/#follow/abc'));
    const share = vi.fn<WebShare>(() => Promise.resolve());
    const copyText = vi.fn(() => Promise.resolve());
    render(
      <CoalitionHome
        {...props({ view: { ...VIEW, share: true }, makeFollowLink, copyText, sharing: { share } })}
      />,
    );

    const followers = region('Followers');
    const shareButton = within(followers).getByRole('button', { name: messages.linkShare.button });
    expect(shareButton).toHaveClass('button-secondary');
    expect(within(followers).getByText(messages.linkShare.chatNote)).toBeVisible();
    await user.click(shareButton);

    expect(makeFollowLink).toHaveBeenCalledOnce();
    expect(await within(followers).findByText(messages.linkShare.shared)).toBeVisible();
    expect(share.mock.calls).toEqual([[{ url: 'https://reconcile.test/#follow/abc' }]]);
    expect(copyText).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('says so when the follow link couldn’t be made, and copies nothing', async () => {
    const user = userEvent.setup();
    const makeFollowLink = vi.fn(() => Promise.reject(new Error('offline')));
    render(<CoalitionHome {...props({ view: { ...VIEW, share: true }, makeFollowLink })} />);
    await user.click(screen.getByRole('button', { name: 'Share a follow link' }));
    expect(
      await within(region('Followers')).findByText(messages.coalitions.shareFailed),
    ).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Follow link' })).not.toBeInTheDocument();
  });
});

describe('CoalitionHome for a follower (#124)', () => {
  const { state, id, dispatches } = coalitionWithDispatch();
  const FOLLOWING: CoalitionHomeView = {
    ...VIEW,
    coalitionId: id,
    members: [
      { name: 'Riverside Tenants', mine: false, coalition: false },
      { name: '<i>Oak St</i> Co-op', mine: false, coalition: false },
    ],
    documents: state.documents,
    standing: { kind: 'reads' },
    dispatches,
    follower: true,
    // A follower's device is in no member group, so it never reads the room (#125).
    room: false,
  };

  it('reads Dispatches first, then Documents and Decided, with nothing to propose or take part in', async () => {
    render(<CoalitionHome {...props({ view: FOLLOWING, state, back: null })} />);

    expect(screen.getByText('Following')).toHaveClass('eyebrow');
    expect(screen.getByRole('heading', { level: 1, name: 'Eastside Housing' })).toBeVisible();
    const groups = screen.getByRole('list', { name: 'Member groups' });
    expect(
      within(groups)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Riverside Tenants', '·<i>Oak St</i> Co-op']);
    const sections = screen
      .getAllByRole('region')
      .map((section) => section.getAttribute('aria-labelledby'));
    const titles = sections.map((label) => document.getElementById(label ?? '')?.textContent);
    expect(titles).toEqual(['Dispatches', 'Documents', 'Decided']);
    expect(within(region('Dispatches')).getByRole('article')).toHaveTextContent(
      'We keep the banks clean.',
    );
    for (const name of ['Open Proposals', 'Take part', 'Member groups', 'Followers']) {
      expect(screen.queryByRole('region', { name })).not.toBeInTheDocument();
    }
    expect(
      screen.queryByRole('button', { name: /Propose|Take part|Share/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Your groups/ })).toHaveAttribute('href', '#/');
    expect(await axeViolations()).toEqual([]);
  });

  it('says there are no Dispatches yet before any', () => {
    render(<CoalitionHome {...props({ view: { ...FOLLOWING, dispatches: [] }, state })} />);
    expect(region('Dispatches')).toHaveTextContent(messages.dispatches.empty);
  });

  it('unfollows only once the dialog is confirmed, saying plainly what it does', async () => {
    const user = userEvent.setup();
    const onUnfollow = vi.fn(() => Promise.resolve());
    render(<CoalitionHome {...props({ view: FOLLOWING, state, onUnfollow })} />);

    await user.click(screen.getByRole('button', { name: 'Unfollow' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Unfollow this coalition?' });
    expect(dialog).toHaveTextContent(messages.coalitions.unfollowBody);
    expect(await axeViolations()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onUnfollow).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Unfollow' }));
    const again = await screen.findByRole('alertdialog');
    await user.click(within(again).getByRole('button', { name: 'Unfollow' }));
    expect(onUnfollow).toHaveBeenCalledTimes(1);
  });
});
