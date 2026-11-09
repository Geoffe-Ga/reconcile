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
  | { readonly name: 'document'; readonly groupId: string };

/** Ids and invite payloads are base64url, joined by at most a dot. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const ID = /^[A-Za-z0-9_-]+$/;

const START: Route = { name: 'start' };

function groupRoute(rest: readonly string[]): Route {
  const [groupId, page, ...extra] = rest;
  if (groupId === undefined || !ID.test(groupId) || extra.length > 0) return START;
  if (page === undefined) return { name: 'group', groupId };
  return page === 'doc' ? { name: 'document', groupId } : START;
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

/** The `href` of a route, starting with `#`. */
export function routeHref(route: Route): string {
  switch (route.name) {
    case 'start':
      return '#/';
    case 'create':
      return '#/create';
    case 'join':
      return route.payload === null ? '#/join' : `#/join/${route.payload}`;
    case 'group':
      return `#/g/${route.groupId}`;
    case 'document':
      return `#/g/${route.groupId}/doc`;
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
