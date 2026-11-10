/**
 * A small hash router (spec §8: hash routes, no router library).
 *
 * Every route lives after `#`, which browsers never send to a server, so an
 * invite's seed in `#join/{seed}` stays on the device. The Join screen
 * replaces that entry with `#/join` once it has read the seed. The tracer's
 * `#/join/{payload}` form still reads as Join, so an old link says plainly
 * that it no longer works.
 */
import { useSyncExternalStore } from 'react';

import { isOptIn, type OptIn } from '../engine/optIns';
import { SEATS, type SeatNumber } from '../engine/stewards';

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
  | { readonly name: 'remove'; readonly groupId: string; readonly atomId: string }
  | { readonly name: 'again'; readonly groupId: string; readonly proposalId: string }
  | {
      readonly name: 'steward';
      readonly groupId: string;
      readonly seat: SeatNumber;
      /** True for Propose recall of the seat's steward, false for Propose a steward (#102). */
      readonly recall: boolean;
    }
  | { readonly name: 'rules'; readonly groupId: string }
  | {
      readonly name: 'optIn';
      readonly groupId: string;
      readonly optIn: OptIn;
      /** True for a steward's Turn off now, which also narrows it at once (#117). */
      readonly narrow: boolean;
    };

/** A route inside one group. */
type GroupRoute = Extract<Route, { readonly groupId: string }>;

/** Ids and invite payloads are base64url, joined by at most a dot. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const ID = /^[A-Za-z0-9_-]+$/;
/** A genesis Atom's id is `${genesisId}.${index}`; an added Atom's is its Proposal's id (#75). */
const ATOM_ID = /^[A-Za-z0-9_-]+(\.[0-9]+)?$/;

const START: Route = { name: 'start' };

/** A steward seat's number as a route writes it, or undefined for anything else. */
function seatIn(arg: string): SeatNumber | undefined {
  return SEATS.find((seat) => String(seat) === arg);
}

/** `steward/{seat}` or, when `recall`, `recall/{seat}`: the steward composer for one seat (#102). */
function stewardPage(groupId: string, recall: boolean, arg: string): Route {
  const seat = seatIn(arg);
  return seat === undefined ? START : { name: 'steward', groupId, seat, recall };
}

/** `rules/{optIn}` or, when `narrow`, `narrow/{optIn}`: the opt-in composer (#117). */
function optInPage(groupId: string, narrow: boolean, arg: string): Route {
  return isOptIn(arg) ? { name: 'optIn', groupId, optIn: arg, narrow } : START;
}

/** The pages inside a group that take nothing after their name. */
const BARE_PAGES: ReadonlyMap<string, (groupId: string) => Route> = new Map([
  ['doc', (groupId: string): Route => ({ name: 'document', groupId })],
  ['rules', (groupId: string): Route => ({ name: 'rules', groupId })],
  ['add', (groupId: string): Route => ({ name: 'add', groupId, after: null })],
]);

/** A page inside a group that takes one argument: its route, or Start when the argument doesn't fit. */
type ArgPage = (groupId: string, arg: string) => Route;

/** A page whose argument must match `pattern`. */
function idPage(pattern: RegExp, make: (groupId: string, id: string) => Route): ArgPage {
  return (groupId, arg) => (pattern.test(arg) ? make(groupId, arg) : START);
}

/** The pages inside a group that take one argument. */
const ARG_PAGES: ReadonlyMap<string, ArgPage> = new Map<string, ArgPage>([
  ['propose', idPage(ATOM_ID, (groupId, atomId) => ({ name: 'propose', groupId, atomId }))],
  ['p', idPage(ID, (groupId, proposalId) => ({ name: 'proposal', groupId, proposalId }))],
  ['again', idPage(ID, (groupId, proposalId) => ({ name: 'again', groupId, proposalId }))],
  ['add', idPage(ATOM_ID, (groupId, after) => ({ name: 'add', groupId, after }))],
  ['remove', idPage(ATOM_ID, (groupId, atomId) => ({ name: 'remove', groupId, atomId }))],
  ['steward', (groupId, arg) => stewardPage(groupId, false, arg)],
  ['recall', (groupId, arg) => stewardPage(groupId, true, arg)],
  ['rules', (groupId, arg) => optInPage(groupId, false, arg)],
  ['narrow', (groupId, arg) => optInPage(groupId, true, arg)],
]);

/**
 * A page inside a group: `doc`, `rules`, `propose/{atomId}`, `p/{proposalId}`,
 * `again/{proposalId}`, `add` (a new first section), `add/{atomId}` (one after
 * that Atom), `remove/{atomId}` (#75), `steward/{seat}`, `recall/{seat}`,
 * `rules/{optIn}` or `narrow/{optIn}`.
 */
function groupPage(groupId: string, page: string, arg: string | undefined): Route {
  if (arg === undefined) return BARE_PAGES.get(page)?.(groupId) ?? START;
  return ARG_PAGES.get(page)?.(groupId, arg) ?? START;
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

/** An invite link's own form: `#join/{seed}`, with no slash after `#` (spec §3). */
const INVITE_PREFIX = '#join/';

/** Reads a `location.hash` value as a route. */
export function parseRoute(hash: string): Route {
  if (hash.startsWith(INVITE_PREFIX)) {
    const rest = hash.slice(INVITE_PREFIX.length).split('/');
    return rest.length === 1 && rest[0] !== '' ? joinRoute(rest) : START;
  }
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

/** Join's `href`: with its invite payload, or bare once Join has read it. */
function joinHref(payload: string | null): string {
  return payload === null ? '#/join' : `${INVITE_PREFIX}${payload}`;
}

/** The path after a page's name: `/{id}`, or nothing when there's none. */
function idPath(id: string | null): string {
  return id === null ? '' : `/${id}`;
}

/** A steward composer's path: `/recall/{seat}` for a recall, else `/steward/{seat}` (#102). */
function stewardPath(route: Extract<Route, { readonly name: 'steward' }>): string {
  const page = route.recall ? 'recall' : 'steward';
  return `/${page}/${String(route.seat)}`;
}

/** An opt-in composer's path: `/narrow/{optIn}` for Turn off now, else `/rules/{optIn}` (#117). */
function optInPath(route: Extract<Route, { readonly name: 'optIn' }>): string {
  return `/${route.narrow ? 'narrow' : 'rules'}/${route.optIn}`;
}

/** A section composer's path (#75): proposing a change, adding a section, or removing one. */
function sectionPath(
  route: Extract<Route, { readonly name: 'propose' | 'add' | 'remove' }>,
): string {
  switch (route.name) {
    case 'propose':
      return `/propose/${route.atomId}`;
    case 'add':
      return `/add${idPath(route.after)}`;
    case 'remove':
      return `/remove/${route.atomId}`;
  }
}

/** The path of a page inside a group, after `#/g/{groupId}`. */
function groupPath(route: GroupRoute): string {
  switch (route.name) {
    case 'group':
      return '';
    case 'document':
      return '/doc';
    case 'rules':
      return '/rules';
    case 'proposal':
      return `/p/${route.proposalId}`;
    case 'again':
      return `/again/${route.proposalId}`;
    case 'steward':
      return stewardPath(route);
    case 'optIn':
      return optInPath(route);
    default:
      return sectionPath(route);
  }
}

/** The `href` of a route, starting with `#`. */
export function routeHref(route: Route): string {
  switch (route.name) {
    case 'start':
      return '#/';
    case 'create':
      return '#/create';
    case 'join':
      return joinHref(route.payload);
    default:
      return `#/g/${route.groupId}${groupPath(route)}`;
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
