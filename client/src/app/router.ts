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
  | { readonly name: 'again'; readonly groupId: string; readonly proposalId: string }
  | {
      readonly name: 'steward';
      readonly groupId: string;
      readonly seat: SeatNumber;
      /** True for Propose recall of the seat's steward, false for Propose a steward (#102). */
      readonly recall: boolean;
    };

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

/** `p/{proposalId}` or `again/{proposalId}`. */
function proposalPage(groupId: string, page: string, arg: string): Route {
  if (!ID.test(arg)) return START;
  if (page === 'p') return { name: 'proposal', groupId, proposalId: arg };
  return page === 'again' ? { name: 'again', groupId, proposalId: arg } : START;
}

/**
 * A page inside a group: `doc`, `propose/{atomId}`, `p/{proposalId}`,
 * `again/{proposalId}`, `steward/{seat}` or `recall/{seat}`.
 */
function groupPage(groupId: string, page: string, arg: string | undefined): Route {
  if (page === 'doc' && arg === undefined) return { name: 'document', groupId };
  if (arg === undefined) return START;
  if (page === 'propose' && ATOM_ID.test(arg)) return { name: 'propose', groupId, atomId: arg };
  if (page === 'steward' || page === 'recall') return stewardPage(groupId, page === 'recall', arg);
  return proposalPage(groupId, page, arg);
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

/** A steward composer's `href`: `recall/{seat}` for a recall, else `steward/{seat}` (#102). */
function stewardHref(route: Extract<Route, { readonly name: 'steward' }>): string {
  const page = route.recall ? 'recall' : 'steward';
  return `#/g/${route.groupId}/${page}/${String(route.seat)}`;
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
    case 'group':
      return `#/g/${route.groupId}`;
    case 'document':
      return `#/g/${route.groupId}/doc`;
    case 'propose':
      return `#/g/${route.groupId}/propose/${route.atomId}`;
    case 'proposal':
      return `#/g/${route.groupId}/p/${route.proposalId}`;
    case 'again':
      return `#/g/${route.groupId}/again/${route.proposalId}`;
    case 'steward':
      return stewardHref(route);
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
