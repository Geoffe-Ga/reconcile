/**
 * A small hash router (spec §8: hash routes, no router library).
 *
 * Every route lives after `#`, which browsers never send to a server, so an
 * invite's seed in `#join/{seed}` stays on the device. The Join screen
 * replaces that entry with `#/join` once it has read the seed. The tracer's
 * `#/join/{payload}` form still reads as Join, so an old link says plainly
 * that it no longer works. A share link's `#share/{seed}.{publicKey}` (#105)
 * reads as the shared page whatever follows it, and stays in the address
 * bar, so a reload reads it again; the page reads a damaged one as not shared.
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
  /** Link a new device, on the existing device (#96). */
  | { readonly name: 'linkNew' }
  /** Link to my other device, on the new device (#96). */
  | { readonly name: 'linkThis' }
  | { readonly name: 'join'; readonly payload: string | null }
  /** A shared personal Document, read-only (#105): what follows `#share/`, as written. */
  | { readonly name: 'shared'; readonly payload: string }
  | { readonly name: 'group'; readonly groupId: string }
  /** One of the group's Documents (#92), by its id; without one, the group's first. */
  | { readonly name: 'document'; readonly groupId: string; readonly documentId?: string }
  /** Propose a new Document (#92). */
  | { readonly name: 'newDocument'; readonly groupId: string }
  | { readonly name: 'propose'; readonly groupId: string; readonly atomId: string }
  | { readonly name: 'proposal'; readonly groupId: string; readonly proposalId: string }
  /**
   * Add a section (#75): after the Atom `after`, in its Document, or at the
   * start of `document` (#92), or of the group's first Document without one.
   */
  | {
      readonly name: 'add';
      readonly groupId: string;
      readonly after: string | null;
      readonly document?: string;
    }
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
    }
  | { readonly name: 'dissolve'; readonly groupId: string }
  /** The group's Dispatches, newest first (#112). */
  | { readonly name: 'dispatches'; readonly groupId: string }
  /** Send a Dispatch (#112). */
  | { readonly name: 'sendDispatch'; readonly groupId: string };

/** A route inside one group. */
export type GroupRoute = Extract<Route, { readonly groupId: string }>;

/** Ids and invite payloads are base64url, joined by at most a dot. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const ID = /^[A-Za-z0-9_-]+$/;
/**
 * A Document's id (#92): the genesis id, `${genesisId}:${k}` for founding
 * Document k ≥ 1, or a new Document's Proposal id.
 */
const DOCUMENT_ID = /^[A-Za-z0-9_-]+(:[0-9]+)?$/;
/**
 * An Atom's id: `${documentId}.${index}` for a Document's first sections, or
 * an added Atom's Proposal id (#75, #92).
 */
const ATOM_ID = /^[A-Za-z0-9_-]+(:[0-9]+)?(\.[0-9]+)?$/;
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

/**
 * The pages inside a group, Group home apart, that take nothing but the
 * group: the rules (#117), dissolving (#108), the Dispatches and Send a
 * Dispatch (#112), and Propose a new Document (#92).
 */
const FIXED_NAMES = ['rules', 'dissolve', 'dispatches', 'sendDispatch', 'newDocument'] as const;

/** A page {@link FIXED_NAMES} lists. */
type FixedName = (typeof FIXED_NAMES)[number];

/** Each fixed page's path after `#/g/{groupId}/`. */
const FIXED_PATHS: Readonly<Record<FixedName, string>> = {
  rules: 'rules',
  dissolve: 'dissolve',
  dispatches: 'dispatches',
  sendDispatch: 'dispatch/new',
  newDocument: 'doc/new',
};

/** The fixed pages by path, as a group's route reads them. */
const FIXED_PAGES: ReadonlyMap<string, FixedName> = new Map(
  FIXED_NAMES.map((name) => [FIXED_PATHS[name], name]),
);

/** A page inside a group that takes one argument: its route, or Start when the argument doesn't fit. */
type ArgPage = (groupId: string, arg: string) => Route;

/** A page whose argument must match `pattern`. */
function idPage(pattern: RegExp, make: (groupId: string, id: string) => Route): ArgPage {
  return (groupId, arg) => (pattern.test(arg) ? make(groupId, arg) : START);
}

/** The pages inside a group that take one argument. */
const ARG_PAGES: ReadonlyMap<string, ArgPage> = new Map<string, ArgPage>([
  [
    'doc',
    idPage(DOCUMENT_ID, (groupId, documentId) => ({ name: 'document', groupId, documentId })),
  ],
  [
    'add-first',
    idPage(DOCUMENT_ID, (groupId, document) => ({ name: 'add', groupId, after: null, document })),
  ],
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
 * The pages inside a group that take nothing, and say so by taking nothing:
 * the group's first Document (`doc`), and a new first section in it (`add`).
 */
const BARE_PAGES: ReadonlyMap<string, ArgPage> = new Map<string, ArgPage>([
  ['doc', (groupId) => ({ name: 'document', groupId })],
  ['add', (groupId) => ({ name: 'add', groupId, after: null })],
]);

/**
 * A page inside a group: one of the fixed pages, such as `dispatch/new` or
 * `doc/new` (#92), `doc` (the first Document) or `add` (a new first section
 * in it, #75), or `doc/{documentId}` (#92), `add-first/{documentId}` (a new
 * first section in that Document, #92), `propose/{atomId}`, `p/{proposalId}`,
 * `again/{proposalId}`, `add/{atomId}` (a new section after that Atom),
 * `remove/{atomId}` (#75), `steward/{seat}`, `recall/{seat}`, `rules/{optIn}`
 * or `narrow/{optIn}`.
 */
function groupPage(groupId: string, page: string, arg: string | undefined): Route {
  const fixed = FIXED_PAGES.get(arg === undefined ? page : `${page}/${arg}`);
  if (fixed !== undefined) return { name: fixed, groupId };
  const make = arg === undefined ? BARE_PAGES.get(page) : ARG_PAGES.get(page);
  return make?.(groupId, arg ?? '') ?? START;
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

/**
 * The pages that take no argument after `#/`: Create group, Settings (#78),
 * and the two sides of linking a device (#96). A linking code never travels
 * in a route: it's shown, scanned or pasted, and held only in memory.
 */
const PAGES: ReadonlyMap<string, Route> = new Map<string, Route>([
  ['create', { name: 'create' }],
  ['settings', { name: 'settings' }],
  ['link-new', { name: 'linkNew' }],
  ['link-this', { name: 'linkThis' }],
]);

/** The pages after `#/` that read what follows them: Join, a group, and Personal (#93). */
const NESTED: ReadonlyMap<string, (rest: readonly string[]) => Route> = new Map([
  ['join', joinRoute],
  ['g', groupRoute],
  ['me', personalRoute],
]);

/** A share link's own form (#105): `#share/{seed}.{publicKey}`, with no slash after `#`. */
const SHARE_PREFIX = '#share/';

/** Reads a `location.hash` value as a route. */
export function parseRoute(hash: string): Route {
  if (hash.startsWith(SHARE_PREFIX))
    return { name: 'shared', payload: hash.slice(SHARE_PREFIX.length) };
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

/**
 * An add's path (#75): after its anchor, or at the start of the Document it
 * names (#92), or of the group's first Document when it names none.
 */
function addPath(route: Extract<Route, { readonly name: 'add' }>): string {
  if (route.after === null && route.document !== undefined) return `/add-first/${route.document}`;
  return `/add${idPath(route.after)}`;
}

/** A section composer's path (#75): proposing a change, adding a section, or removing one. */
function sectionPath(
  route: Extract<Route, { readonly name: 'propose' | 'add' | 'remove' }>,
): string {
  switch (route.name) {
    case 'propose':
      return `/propose/${route.atomId}`;
    case 'add':
      return addPath(route);
    case 'remove':
      return `/remove/${route.atomId}`;
  }
}

/** The path of a page inside a group, after `#/g/{groupId}`. */
function groupPath(route: GroupRoute): string {
  switch (route.name) {
    case 'group':
      return '';
    case 'proposal':
      return `/p/${route.proposalId}`;
    case 'again':
      return `/again/${route.proposalId}`;
    case 'steward':
      return stewardPath(route);
    case 'optIn':
      return optInPath(route);
    case 'propose':
    case 'add':
    case 'remove':
      return sectionPath(route);
    default:
      return pagePath(route);
  }
}

/** The path of a group page that names at most a Document (#92): one of the group's Documents, or a fixed page. */
function pagePath(route: Extract<GroupRoute, { readonly name: 'document' | FixedName }>): string {
  return route.name === 'document'
    ? `/doc${idPath(route.documentId ?? null)}`
    : `/${FIXED_PATHS[route.name]}`;
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
    case 'linkNew':
      return '#/link-new';
    case 'linkThis':
      return '#/link-this';
    case 'join':
      return joinHref(route.payload);
    case 'shared':
      return `${SHARE_PREFIX}${route.payload}`;
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
