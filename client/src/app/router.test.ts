import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { navigate, parseRoute, replaceRoute, routeHref, type Route, useRoute } from './router';

const GROUP = 'g'.repeat(43);
const ATOM = `${GROUP}.0`;
const PROPOSAL = 'p'.repeat(43);
/** The group's second founding Document (#92), and one of its sections. */
const SECOND = `${GROUP}:1`;
const SECOND_ATOM = `${SECOND}.0`;
/** A personal Document's id (#93): 16 bytes in unpadded base64url. */
const PERSONAL = 'Q2FuYXJ5IHN0YXRlbWVudA';
/** A share link's payload (#105): its seed and public key, 43 base64url characters each. */
const SHARE = `${'s'.repeat(43)}.${'k'.repeat(43)}`;

afterEach(() => {
  window.history.replaceState(null, '', '#/');
});

describe('parseRoute', () => {
  it.each<[string, Route]>([
    ['', { name: 'start' }],
    ['#', { name: 'start' }],
    ['#/', { name: 'start' }],
    ['#/create', { name: 'create' }],
    ['#/settings', { name: 'settings' }],
    ['#/me', { name: 'personal' }],
    [`#/me/${PERSONAL}`, { name: 'personalDocument', id: PERSONAL }],
    ['#/me/A-_aAAAAAAAAAAAAAAAAAA', { name: 'personalDocument', id: 'A-_aAAAAAAAAAAAAAAAAAA' }],
    ['#/link-new', { name: 'linkNew' }],
    ['#/link-this', { name: 'linkThis' }],
    ['#/recovery', { name: 'recovery' }],
    ['#/join', { name: 'join', payload: null }],
    ['#/join/abc.def', { name: 'join', payload: 'abc.def' }],
    ['#join/abc-def', { name: 'join', payload: 'abc-def' }],
    ['#join/abc.def', { name: 'join', payload: 'abc.def' }],
    [`#share/${SHARE}`, { name: 'shared', payload: SHARE }],
    // Any #share/ link reaches the shared page, which reads a damaged one as not shared (#105).
    ['#share/', { name: 'shared', payload: '' }],
    ['#share/abc/def', { name: 'shared', payload: 'abc/def' }],
    ['#share/has space', { name: 'shared', payload: 'has space' }],
    // Any #door/ link reaches the front door, which reads a damaged one itself (#121).
    [`#door/${SHARE.slice(0, 43)}`, { name: 'door', payload: SHARE.slice(0, 43) }],
    ['#door/', { name: 'door', payload: '' }],
    ['#door/abc/def', { name: 'door', payload: 'abc/def' }],
    [`#/g/${GROUP}`, { name: 'group', groupId: GROUP }],
    [`#/g/${GROUP}/doc`, { name: 'document', groupId: GROUP }],
    [`#/g/${GROUP}/doc/${GROUP}`, { name: 'document', groupId: GROUP, documentId: GROUP }],
    [`#/g/${GROUP}/doc/${SECOND}`, { name: 'document', groupId: GROUP, documentId: SECOND }],
    [`#/g/${GROUP}/doc/${PROPOSAL}`, { name: 'document', groupId: GROUP, documentId: PROPOSAL }],
    [`#/g/${GROUP}/doc/new`, { name: 'newDocument', groupId: GROUP }],
    [
      `#/g/${GROUP}/add-first/${SECOND}`,
      { name: 'add', groupId: GROUP, after: null, document: SECOND },
    ],
    [`#/g/${GROUP}/add/${SECOND_ATOM}`, { name: 'add', groupId: GROUP, after: SECOND_ATOM }],
    [
      `#/g/${GROUP}/propose/${SECOND_ATOM}`,
      { name: 'propose', groupId: GROUP, atomId: SECOND_ATOM },
    ],
    [`#/g/${GROUP}/remove/${SECOND_ATOM}`, { name: 'remove', groupId: GROUP, atomId: SECOND_ATOM }],
    [`#/g/${GROUP}/priority`, { name: 'priority', groupId: GROUP }],
    [`#/g/${GROUP}/propose/${ATOM}`, { name: 'propose', groupId: GROUP, atomId: ATOM }],
    [`#/g/${GROUP}/p/${PROPOSAL}`, { name: 'proposal', groupId: GROUP, proposalId: PROPOSAL }],
    [`#/g/${GROUP}/add`, { name: 'add', groupId: GROUP, after: null }],
    [`#/g/${GROUP}/add/${ATOM}`, { name: 'add', groupId: GROUP, after: ATOM }],
    [`#/g/${GROUP}/add/${PROPOSAL}`, { name: 'add', groupId: GROUP, after: PROPOSAL }],
    [`#/g/${GROUP}/remove/${ATOM}`, { name: 'remove', groupId: GROUP, atomId: ATOM }],
    [`#/g/${GROUP}/remove/${PROPOSAL}`, { name: 'remove', groupId: GROUP, atomId: PROPOSAL }],
    [`#/g/${GROUP}/again/${PROPOSAL}`, { name: 'again', groupId: GROUP, proposalId: PROPOSAL }],
    [`#/g/${GROUP}/steward/1`, { name: 'steward', groupId: GROUP, seat: 1, recall: false }],
    [`#/g/${GROUP}/steward/2`, { name: 'steward', groupId: GROUP, seat: 2, recall: false }],
    [`#/g/${GROUP}/recall/1`, { name: 'steward', groupId: GROUP, seat: 1, recall: true }],
    [`#/g/${GROUP}/rules`, { name: 'rules', groupId: GROUP }],
    [
      `#/g/${GROUP}/rules/chatBot`,
      { name: 'optIn', groupId: GROUP, optIn: 'chatBot', narrow: false },
    ],
    [
      `#/g/${GROUP}/rules/frontDoor`,
      { name: 'optIn', groupId: GROUP, optIn: 'frontDoor', narrow: false },
    ],
    [
      `#/g/${GROUP}/narrow/chatBot`,
      { name: 'optIn', groupId: GROUP, optIn: 'chatBot', narrow: true },
    ],
    [`#/g/${GROUP}/dissolve`, { name: 'dissolve', groupId: GROUP }],
    // A member's removal (#115) has its own page: an added section's id is a Proposal's (#75).
    [
      `#/g/${GROUP}/remove-member/${PROPOSAL}`,
      { name: 'removal', groupId: GROUP, member: PROPOSAL },
    ],
    [`#/g/${GROUP}/dispatches`, { name: 'dispatches', groupId: GROUP }],
    [`#/g/${GROUP}/dispatch/new`, { name: 'sendDispatch', groupId: GROUP }],
  ])('reads %j', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it.each([
    '#/nowhere',
    '#/create/extra',
    '#/settings/extra',
    '#/me/',
    `#/me/${PERSONAL}/extra`,
    `#/me/${PERSONAL}A`,
    `#/me/${PERSONAL.slice(1)}`,
    '#/me/has space in its twenty',
    `#/me/${PERSONAL.slice(1)}=`,
    `#/me/${'A'.repeat(21)}B`,
    `#/me/${'%2e'.repeat(7)}a`,
    '#/link-new/RL1.code',
    '#/link-this/RL1.code',
    '#/g/',
    '#/g/has space',
    '#/g/%2e%2e',
    `#/g/${GROUP}/doc/has space`,
    `#/g/${GROUP}/settings`,
    `#/g/${GROUP}/propose`,
    `#/g/${GROUP}/propose/`,
    `#/g/${GROUP}/propose/has space`,
    `#/g/${GROUP}/propose/${ATOM}/extra`,
    `#/g/${GROUP}/p`,
    `#/g/${GROUP}/p/${ATOM}`,
    `#/g/${GROUP}/p/${PROPOSAL}/extra`,
    `#/g/${GROUP}/again`,
    `#/g/${GROUP}/again/${ATOM}`,
    `#/g/${GROUP}/again/${PROPOSAL}/extra`,
    `#/g/${GROUP}/doc/${ATOM}`,
    `#/g/${GROUP}/doc/${SECOND_ATOM}`,
    `#/g/${GROUP}/doc/${GROUP}:x`,
    `#/g/${GROUP}/doc/${SECOND}:2`,
    `#/g/${GROUP}/doc/new/extra`,
    `#/g/${GROUP}/doc/${SECOND}/extra`,
    `#/g/${GROUP}/add-first`,
    `#/g/${GROUP}/add-first/`,
    `#/g/${GROUP}/add-first/${SECOND_ATOM}`,
    `#/g/${GROUP}/add-first/${SECOND}/extra`,
    `#/g/${GROUP}/propose/${SECOND}:2.0`,
    `#/g/${GROUP}/propose/${GROUP}:.0`,
    `#/g/${GROUP}/priority/${PROPOSAL}`,
    `#/g/${GROUP}/add/`,
    `#/g/${GROUP}/add/has space`,
    `#/g/${GROUP}/add/${ATOM}/extra`,
    `#/g/${GROUP}/remove`,
    `#/g/${GROUP}/remove/`,
    `#/g/${GROUP}/remove/has space`,
    `#/g/${GROUP}/constructor`,
    `#/g/${GROUP}/constructor/${ATOM}`,
    `#/g/${GROUP}/__proto__/${ATOM}`,
    `#/g/${GROUP}/steward`,
    `#/g/${GROUP}/steward/0`,
    `#/g/${GROUP}/steward/3`,
    `#/g/${GROUP}/steward/01`,
    `#/g/${GROUP}/recall/x`,
    `#/g/${GROUP}/steward/1/extra`,
    `#/g/${GROUP}/rules/signalBot`,
    `#/g/${GROUP}/rules/chatbot`,
    `#/g/${GROUP}/rules/chatBot/extra`,
    `#/g/${GROUP}/narrow`,
    `#/g/${GROUP}/narrow/toString`,
    `#/g/${GROUP}/dissolve/${PROPOSAL}`,
    `#/g/${GROUP}/dissolve/extra/more`,
    `#/g/${GROUP}/remove-member`,
    `#/g/${GROUP}/remove-member/`,
    `#/g/${GROUP}/remove-member/has space`,
    `#/g/${GROUP}/remove-member/${ATOM}`,
    `#/g/${GROUP}/remove-member/${PROPOSAL}/extra`,
    `#/g/${GROUP}/dispatch`,
    `#/g/${GROUP}/dispatch/`,
    `#/g/${GROUP}/dispatch/old`,
    `#/g/${GROUP}/dispatch/${PROPOSAL}`,
    `#/g/${GROUP}/dispatch/new/extra`,
    `#/g/${GROUP}/dispatches/new`,
    `#/g/${GROUP}/dispatches/${PROPOSAL}`,
    '#/join/',
    '#join',
    '#join/',
    '#join/abc/def',
    '#join/has space',
    '#/share/abc',
    '#share',
    'create',
  ])('sends the unknown %j to Start', (hash) => {
    expect(parseRoute(hash)).toEqual({ name: 'start' });
  });

  // Add a section and Propose removing (#75) live only inside a group, beside
  // Personal (#93), linking a device (#96), a share link (#105) and the
  // Dispatches (#112).
  it.each<[string, Route]>([
    ['#/add', { name: 'start' }],
    [`#/add/${ATOM}`, { name: 'start' }],
    [`#/remove/${ATOM}`, { name: 'start' }],
    ['#/me/add', { name: 'start' }],
    [`#/me/${PERSONAL}/add`, { name: 'start' }],
    [`#/me/remove/${PERSONAL}`, { name: 'start' }],
    ['#/link-new/add', { name: 'start' }],
    [`#/link-this/remove/${ATOM}`, { name: 'start' }],
    [`#share/${SHARE}/add`, { name: 'shared', payload: `${SHARE}/add` }],
    [`#share/${SHARE}/remove/${ATOM}`, { name: 'shared', payload: `${SHARE}/remove/${ATOM}` }],
    // Beside the Dispatches (#112), whose `dispatch/new` is the one two-part fixed page.
    [`#/g/${GROUP}/dispatch/add`, { name: 'start' }],
    [`#/g/${GROUP}/dispatches/add`, { name: 'start' }],
    [`#/g/${GROUP}/dispatch/new`, { name: 'sendDispatch', groupId: GROUP }],
    [`#/g/${GROUP}/add`, { name: 'add', groupId: GROUP, after: null }],
  ])('keeps the section pages inside a group: %j', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });
});

describe('share links and Dispatches (#105, #112)', () => {
  it('reads a share link as the shared page whatever follows, and a Dispatch route as itself', () => {
    expect(parseRoute(`#share/g/${GROUP}/dispatches`)).toEqual({
      name: 'shared',
      payload: `g/${GROUP}/dispatches`,
    });
    expect(parseRoute(`#/g/${GROUP}/dispatch/new`)).toEqual({
      name: 'sendDispatch',
      groupId: GROUP,
    });
    expect(parseRoute(`#/g/${GROUP}/dispatches`)).toEqual({ name: 'dispatches', groupId: GROUP });
  });
});

describe('reconcile cards (#114)', () => {
  it.each([`#reconcile/abc/def`, `#reconcile/`, `#reconcile/a+b`, `#/card/abc`])(
    'sends %j to Start',
    (hash) => {
      expect(parseRoute(hash)).toEqual({ name: 'start' });
    },
  );
});

describe('coalitions (#120)', () => {
  const COALITION = 'c'.repeat(43);

  it('reads a coalition’s home, its Document and its composer', () => {
    expect(parseRoute(`#/c/${COALITION}`)).toEqual({ name: 'coalition', coalitionId: COALITION });
    expect(parseRoute(`#/c/${COALITION}/doc/${COALITION}`)).toEqual({
      name: 'coalitionDocument',
      coalitionId: COALITION,
      documentId: COALITION,
    });
    expect(parseRoute(`#/c/${COALITION}/propose/${COALITION}.2`)).toEqual({
      name: 'coalitionPropose',
      coalitionId: COALITION,
      atomId: `${COALITION}.2`,
    });
  });

  it('reads a coalition’s room (#125)', () => {
    expect(parseRoute(`#/c/${COALITION}/room`)).toEqual({
      name: 'coalitionRoom',
      coalitionId: COALITION,
    });
  });

  it('reads a later Document’s id, as several Documents name it (#92)', () => {
    expect(parseRoute(`#/c/${COALITION}/doc/${COALITION}:1`)).toEqual({
      name: 'coalitionDocument',
      coalitionId: COALITION,
      documentId: `${COALITION}:1`,
    });
  });

  it.each([
    '#/c',
    '#/c/',
    `#/c/${COALITION}/doc`,
    `#/c/${COALITION}/doc/a+b`,
    `#/c/${COALITION}/doc/${COALITION}/more`,
    `#/c/${COALITION}/propose`,
    `#/c/${COALITION}/propose/a.b`,
    `#/c/${COALITION}/p/${COALITION}`,
    `#/c/${COALITION}/room/${COALITION}`,
    `#/c/${COALITION}/rooms`,
    '#/c/a+b',
  ])('sends %j to Start', (hash) => {
    expect(parseRoute(hash)).toEqual({ name: 'start' });
  });
});

describe('routeHref', () => {
  it.each<[Route, string]>([
    [{ name: 'start' }, '#/'],
    [{ name: 'create' }, '#/create'],
    [{ name: 'settings' }, '#/settings'],
    [{ name: 'personal' }, '#/me'],
    [{ name: 'personalDocument', id: PERSONAL }, `#/me/${PERSONAL}`],
    [{ name: 'linkNew' }, '#/link-new'],
    [{ name: 'linkThis' }, '#/link-this'],
    [{ name: 'recovery' }, '#/recovery'],
    [{ name: 'join', payload: null }, '#/join'],
    [{ name: 'join', payload: 'abc-def' }, '#join/abc-def'],
    [{ name: 'shared', payload: SHARE }, `#share/${SHARE}`],
    [{ name: 'door', payload: 'abc' }, '#door/abc'],
    [{ name: 'group', groupId: GROUP }, `#/g/${GROUP}`],
    [{ name: 'document', groupId: GROUP }, `#/g/${GROUP}/doc`],
    [{ name: 'document', groupId: GROUP, documentId: SECOND }, `#/g/${GROUP}/doc/${SECOND}`],
    [{ name: 'newDocument', groupId: GROUP }, `#/g/${GROUP}/doc/new`],
    [
      { name: 'add', groupId: GROUP, after: null, document: SECOND },
      `#/g/${GROUP}/add-first/${SECOND}`,
    ],
    [{ name: 'priority', groupId: GROUP }, `#/g/${GROUP}/priority`],
    [{ name: 'propose', groupId: GROUP, atomId: ATOM }, `#/g/${GROUP}/propose/${ATOM}`],
    [{ name: 'proposal', groupId: GROUP, proposalId: PROPOSAL }, `#/g/${GROUP}/p/${PROPOSAL}`],
    [{ name: 'add', groupId: GROUP, after: null }, `#/g/${GROUP}/add`],
    [{ name: 'add', groupId: GROUP, after: ATOM }, `#/g/${GROUP}/add/${ATOM}`],
    [{ name: 'remove', groupId: GROUP, atomId: ATOM }, `#/g/${GROUP}/remove/${ATOM}`],
    [{ name: 'again', groupId: GROUP, proposalId: PROPOSAL }, `#/g/${GROUP}/again/${PROPOSAL}`],
    [{ name: 'steward', groupId: GROUP, seat: 2, recall: false }, `#/g/${GROUP}/steward/2`],
    [{ name: 'steward', groupId: GROUP, seat: 1, recall: true }, `#/g/${GROUP}/recall/1`],
    [{ name: 'rules', groupId: GROUP }, `#/g/${GROUP}/rules`],
    [
      { name: 'optIn', groupId: GROUP, optIn: 'frontDoor', narrow: false },
      `#/g/${GROUP}/rules/frontDoor`,
    ],
    [
      { name: 'optIn', groupId: GROUP, optIn: 'chatBot', narrow: true },
      `#/g/${GROUP}/narrow/chatBot`,
    ],
    [{ name: 'dissolve', groupId: GROUP }, `#/g/${GROUP}/dissolve`],
    [
      { name: 'removal', groupId: GROUP, member: PROPOSAL },
      `#/g/${GROUP}/remove-member/${PROPOSAL}`,
    ],
    [{ name: 'dispatches', groupId: GROUP }, `#/g/${GROUP}/dispatches`],
    [{ name: 'sendDispatch', groupId: GROUP }, `#/g/${GROUP}/dispatch/new`],
    [{ name: 'reconcile', groupId: GROUP }, `#/g/${GROUP}/reconcile`],
    [{ name: 'card', payload: null }, '#/card'],
    [{ name: 'card', payload: 'abc-def' }, '#reconcile/abc-def'],
    [{ name: 'coalition', coalitionId: GROUP }, `#/c/${GROUP}`],
    [
      { name: 'coalitionDocument', coalitionId: GROUP, documentId: GROUP },
      `#/c/${GROUP}/doc/${GROUP}`,
    ],
    [
      { name: 'coalitionPropose', coalitionId: GROUP, atomId: ATOM },
      `#/c/${GROUP}/propose/${ATOM}`,
    ],
    [{ name: 'coalitionRoom', coalitionId: GROUP }, `#/c/${GROUP}/room`],
  ])('writes %j as %s, which parses back', (route, href) => {
    expect(routeHref(route)).toBe(href);
    expect(parseRoute(href)).toEqual(route);
  });
});

describe('useRoute', () => {
  it('follows navigation and hash changes', () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: 'start' });

    act(() => {
      navigate({ name: 'create' });
    });
    expect(window.location.hash).toBe('#/create');
    expect(result.current).toEqual({ name: 'create' });

    act(() => {
      window.location.hash = `#/g/${GROUP}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(result.current).toEqual({ name: 'group', groupId: GROUP });
  });

  it('follows a replaced route without adding a history entry', () => {
    window.history.replaceState(null, '', '#/join/abc.def');
    const before = window.history.length;
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: 'join', payload: 'abc.def' });

    act(() => {
      replaceRoute({ name: 'join', payload: null });
    });
    expect(window.location.hash).toBe('#/join');
    expect(window.history.length).toBe(before);
    expect(result.current).toEqual({ name: 'join', payload: null });
  });

  it('stops listening once unmounted', () => {
    const { result, unmount } = renderHook(() => useRoute());
    unmount();
    act(() => {
      replaceRoute({ name: 'create' });
    });
    expect(result.current).toEqual({ name: 'start' });
  });
});
