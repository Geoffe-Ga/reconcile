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
  | { readonly name: 'settings' }
  /** Personal (#93): this device's personal Documents. */
  | { readonly name: 'personal' }
  /** One personal Document, by its id, to read and edit (#93). */
  | { readonly name: 'personalDocument'; readonly id: string }
  | { readonly name: 'join'; readonly payload: string | null }
  | { readonly name: 'group'; readonly groupId: string }
  | { readonly name: 'document'; readonly groupId: string }
  | { readonly name: 'propose'; readonly groupId: string; readonly atomId: string }
  | { readonly name: 'proposal'; readonly groupId: string; readonly proposalId: string }
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
    }
  | { readonly name: 'dissolve'; readonly groupId: string };

/** A route inside one group. */
export type GroupRoute = Extract<Route, { readonly groupId: string }>;

/** Ids and invite payloads are base64url, joined by at most a dot. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const ID = /^[A-Za-z0-9_-]+$/;
/** A genesis Atom's id is `${genesisId}.${index}`; an added Atom's is its Proposal's id (#75). */
const ATOM_ID = /^[A-Za-z0-9_-]+(\.[0-9]+)?$/;
/** A personal Document's id (#93): 16 bytes in canonical unpadded base64url, 22 characters. */
const PERSONAL_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/;

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

/** A page with no argument: `doc`, `rules` (#117) or `dissolve` (#108). */
function barePage(groupId: string, page: string): Route {
  if (page === 'doc') return { name: 'document', groupId };
  if (page === 'dissolve') return { name: 'dissolve', groupId };
  return page === 'rules' ? { name: 'rules', groupId } : START;
}

/** `p/{proposalId}` or `again/{proposalId}`. */
function proposalPage(groupId: string, page: string, arg: string): Route {
  if (!ID.test(arg)) return START;
  if (page === 'p') return { name: 'proposal', groupId, proposalId: arg };
  return page === 'again' ? { name: 'again', groupId, proposalId: arg } : START;
}

/**
 * A page inside a group: `doc`, `rules`, `dissolve`, `propose/{atomId}`,
 * `p/{proposalId}`, `again/{proposalId}`, `steward/{seat}`, `recall/{seat}`,
 * `rules/{optIn}` or `narrow/{optIn}`.
 */
function groupPage(groupId: string, page: string, arg: string | undefined): Route {
  if (arg === undefined) return barePage(groupId, page);
  if (page === 'propose' && ATOM_ID.test(arg)) return { name: 'propose', groupId, atomId: arg };
  if (page === 'steward' || page === 'recall') return stewardPage(groupId, page === 'recall', arg);
  if (page === 'rules' || page === 'narrow') return optInPage(groupId, page === 'narrow', arg);
  return proposalPage(groupId, page, arg);
}

function groupRoute(rest: readonly string[]): Route {
  const [groupId, page, arg, ...extra] = rest;
  if (groupId === undefined || !ID.test(groupId) || extra.length > 0) return START;
  return page === undefined ? { name: 'group', groupId } : groupPage(groupId, page, arg);
}

/** `#/me` (Personal), or `#/me/{id}`, one personal Document (#93). */
function personalRoute(rest: readonly string[]): Route {
  if (rest.length === 0) return { name: 'personal' };
  const [id] = rest;
  return rest.length === 1 && id !== undefined && PERSONAL_ID.test(id)
    ? { name: 'personalDocument', id }
    : START;
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

/** The pages that take no argument after `#/`: Create group and Settings (#78). */
const PAGES: ReadonlyMap<string, Route> = new Map<string, Route>([
  ['create', { name: 'create' }],
  ['settings', { name: 'settings' }],
]);

/** The pages after `#/` that read what follows them: Join, a group, and Personal (#93). */
const NESTED: ReadonlyMap<string, (rest: readonly string[]) => Route> = new Map([
  ['join', joinRoute],
  ['g', groupRoute],
  ['me', personalRoute],
]);

/** Reads a `location.hash` value as a route. */
export function parseRoute(hash: string): Route {
  if (hash.startsWith(INVITE_PREFIX)) {
    const rest = hash.slice(INVITE_PREFIX.length).split('/');
    return rest.length === 1 && rest[0] !== '' ? joinRoute(rest) : START;
  }
  if (!hash.startsWith('#/')) return START;
  const [head = '', ...rest] = hash.slice(2).split('/');
  const nested = NESTED.get(head);
  if (nested !== undefined) return nested(rest);
  return rest.length === 0 ? (PAGES.get(head) ?? START) : START;
}

/** Join's `href`: with its invite payload, or bare once Join has read it. */
function joinHref(payload: string | null): string {
  return payload === null ? '#/join' : `${INVITE_PREFIX}${payload}`;
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

/** The path of a page inside a group, after `#/g/{groupId}`. */
function groupPath(route: GroupRoute): string {
  switch (route.name) {
    case 'group':
      return '';
    case 'document':
      return '/doc';
    case 'rules':
      return '/rules';
    case 'propose':
      return `/propose/${route.atomId}`;
    case 'proposal':
      return `/p/${route.proposalId}`;
    case 'again':
      return `/again/${route.proposalId}`;
    case 'steward':
      return stewardPath(route);
    case 'optIn':
      return optInPath(route);
    case 'dissolve':
      return '/dissolve';
  }
}

/** The `href` of a route, starting with `#`. */
export function routeHref(route: Route): string {
  switch (route.name) {
    case 'start':
      return '#/';
    case 'create':
      return '#/create';
    case 'settings':
      return '#/settings';
    case 'personal':
      return '#/me';
    case 'personalDocument':
      return `#/me/${route.id}`;
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
