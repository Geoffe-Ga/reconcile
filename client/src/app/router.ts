/**
 * A small hash router (spec §8: hash routes, no router library).
 *
 * Every route lives after `#`, which browsers never send to a server, so an
 * invite's secret in `#/join/{payload}` stays on the device. The Join screen
 * replaces that entry with `#/join` once it has read the payload.
 */
import { useSyncExternalStore } from 'react';

/** Where the app is. Unknown hashes read as Start. */
export type Route =
  | { readonly name: 'start' }
  | { readonly name: 'create' }
  | { readonly name: 'join'; readonly payload: string | null }
  | { readonly name: 'group'; readonly groupId: string }
  | { readonly name: 'document'; readonly groupId: string }
  | { readonly name: 'propose'; readonly groupId: string; readonly atomId: string }
  | { readonly name: 'proposal'; readonly groupId: string; readonly proposalId: string }
  | { readonly name: 'add'; readonly groupId: string; readonly after: string | null }
  | { readonly name: 'remove'; readonly groupId: string; readonly atomId: string };

/** Ids and invite payloads are base64url, joined by at most a dot. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const ID = /^[A-Za-z0-9_-]+$/;
/** A genesis Atom's id is `${genesisId}.${index}`; an added Atom's is its Proposal's id (#75). */
const ATOM_ID = /^[A-Za-z0-9_-]+(\.[0-9]+)?$/;

const START: Route = { name: 'start' };

/** The pages inside a group that take nothing after their name. */
const BARE_PAGES: ReadonlyMap<string, (groupId: string) => Route> = new Map([
  ['doc', (groupId: string): Route => ({ name: 'document', groupId })],
  ['add', (groupId: string): Route => ({ name: 'add', groupId, after: null })],
]);

/** The pages inside a group that take one id, the pattern it must match, and their route. */
const ID_PAGES: ReadonlyMap<string, readonly [RegExp, (groupId: string, id: string) => Route]> =
  new Map([
    ['propose', [ATOM_ID, (groupId, atomId) => ({ name: 'propose', groupId, atomId })]],
    ['p', [ID, (groupId, proposalId) => ({ name: 'proposal', groupId, proposalId })]],
    ['add', [ATOM_ID, (groupId, after) => ({ name: 'add', groupId, after })]],
    ['remove', [ATOM_ID, (groupId, atomId) => ({ name: 'remove', groupId, atomId })]],
  ]);

/**
 * A page inside a group: `doc`, `propose/{atomId}`, `p/{proposalId}`, `add`
 * (a new first section), `add/{atomId}` (one after that Atom) or
 * `remove/{atomId}` (#75).
 */
function groupPage(groupId: string, page: string, arg: string | undefined): Route {
  if (arg === undefined) return BARE_PAGES.get(page)?.(groupId) ?? START;
  const known = ID_PAGES.get(page);
  return known?.[0].test(arg) === true ? known[1](groupId, arg) : START;
}

function groupRoute(rest: readonly string[]): Route {
  const [groupId, page, arg, ...extra] = rest;
  if (groupId === undefined || !ID.test(groupId) || extra.length > 0) return START;
  return page === undefined ? { name: 'group', groupId } : groupPage(groupId, page, arg);
}

function joinRoute(rest: readonly string[]): Route {
  if (rest.length === 0) return { name: 'join', payload: null };
  const [payload] = rest;
  return rest.length === 1 && payload !== undefined && SEGMENT.test(payload)
    ? { name: 'join', payload }
    : START;
}

/** Reads a `location.hash` value as a route. */
export function parseRoute(hash: string): Route {
  if (!hash.startsWith('#/')) return START;
  const [head = '', ...rest] = hash.slice(2).split('/');
  switch (head) {
    case 'create':
      return rest.length === 0 ? { name: 'create' } : START;
    case 'join':
      return joinRoute(rest);
    case 'g':
      return groupRoute(rest);
    default:
      return START;
  }
}

/** The path after a page's name: `/{id}`, or nothing when there's none. */
function idPath(id: string | null): string {
  return id === null ? '' : `/${id}`;
}

/** The `href` of a route, starting with `#`. */
export function routeHref(route: Route): string {
  switch (route.name) {
    case 'start':
      return '#/';
    case 'create':
      return '#/create';
    case 'join':
      return `#/join${idPath(route.payload)}`;
    case 'group':
      return `#/g/${route.groupId}`;
    case 'document':
      return `#/g/${route.groupId}/doc`;
    case 'propose':
      return `#/g/${route.groupId}/propose/${route.atomId}`;
    case 'proposal':
      return `#/g/${route.groupId}/p/${route.proposalId}`;
    case 'add':
      return `#/g/${route.groupId}/add${idPath(route.after)}`;
    case 'remove':
      return `#/g/${route.groupId}/remove/${route.atomId}`;
  }
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('hashchange', listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', listener);
    window.removeEventListener('popstate', listener);
  };
}

function currentHash(): string {
  return window.location.hash;
}

/** Goes to `route`, adding a history entry. */
export function navigate(route: Route): void {
  window.location.hash = routeHref(route);
  notify();
}

/** Goes to `route` in place of the current history entry, so Back never returns to it. */
export function replaceRoute(route: Route): void {
  window.history.replaceState(null, '', routeHref(route));
  notify();
}

/** The current route, kept up to date as the hash changes. */
export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, currentHash));
}
