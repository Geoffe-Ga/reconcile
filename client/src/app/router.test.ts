import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { navigate, parseRoute, replaceRoute, routeHref, type Route, useRoute } from './router';

const GROUP = 'g'.repeat(43);
const ATOM = `${GROUP}.0`;
const PROPOSAL = 'p'.repeat(43);
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
    ['#/join', { name: 'join', payload: null }],
    ['#/join/abc.def', { name: 'join', payload: 'abc.def' }],
    ['#join/abc-def', { name: 'join', payload: 'abc-def' }],
    ['#join/abc.def', { name: 'join', payload: 'abc.def' }],
    [`#share/${SHARE}`, { name: 'shared', payload: SHARE }],
    // Any #share/ link reaches the shared page, which reads a damaged one as not shared (#105).
    ['#share/', { name: 'shared', payload: '' }],
    ['#share/abc/def', { name: 'shared', payload: 'abc/def' }],
    ['#share/has space', { name: 'shared', payload: 'has space' }],
    [`#/g/${GROUP}`, { name: 'group', groupId: GROUP }],
    [`#/g/${GROUP}/doc`, { name: 'document', groupId: GROUP }],
    [`#/g/${GROUP}/propose/${ATOM}`, { name: 'propose', groupId: GROUP, atomId: ATOM }],
    [`#/g/${GROUP}/p/${PROPOSAL}`, { name: 'proposal', groupId: GROUP, proposalId: PROPOSAL }],
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
    [`#/g/${GROUP}/remove/${PROPOSAL}`, { name: 'removal', groupId: GROUP, member: PROPOSAL }],
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
    `#/g/${GROUP}/doc/extra`,
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
    `#/g/${GROUP}/remove`,
    `#/g/${GROUP}/remove/${ATOM}`,
    `#/g/${GROUP}/remove/${PROPOSAL}/extra`,
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
    [{ name: 'join', payload: null }, '#/join'],
    [{ name: 'join', payload: 'abc-def' }, '#join/abc-def'],
    [{ name: 'shared', payload: SHARE }, `#share/${SHARE}`],
    [{ name: 'group', groupId: GROUP }, `#/g/${GROUP}`],
    [{ name: 'document', groupId: GROUP }, `#/g/${GROUP}/doc`],
    [{ name: 'propose', groupId: GROUP, atomId: ATOM }, `#/g/${GROUP}/propose/${ATOM}`],
    [{ name: 'proposal', groupId: GROUP, proposalId: PROPOSAL }, `#/g/${GROUP}/p/${PROPOSAL}`],
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
    [{ name: 'removal', groupId: GROUP, member: PROPOSAL }, `#/g/${GROUP}/remove/${PROPOSAL}`],
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
