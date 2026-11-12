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
 * A front door's `#door/{address}` (#121) reads the same way: it carries no
 * secret, so it stays in the address bar too.
 */
import { useSyncExternalStore } from 'react';

import type { HeadingLevel } from '../engine/atomText';
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
  /** Choose recovery contacts, or choose again (#109). */
  | { readonly name: 'recovery' }
  /** Recover with my contacts, on a new device (#118). */
  | { readonly name: 'recover' }
  /** Help someone recover, on a recovery contact's device (#118). */
  | { readonly name: 'helpRecover' }
  | { readonly name: 'join'; readonly payload: string | null }
  /** A reconcile card (#114): its seed as written after `#reconcile/`, or null once read. */
  | { readonly name: 'card'; readonly payload: string | null }
  /** A coalition's follow link (#124): its seed as written after `#follow/`, or null once read. */
  | { readonly name: 'follow'; readonly payload: string | null }
  /** A shared personal Document, read-only (#105): what follows `#share/`, as written. */
  | { readonly name: 'shared'; readonly payload: string }
  /** A group's front door (#121): what follows `#door/`, as written. */
  | { readonly name: 'door'; readonly payload: string }
  | { readonly name: 'group'; readonly groupId: string }
  /** One of the group's Documents (#92), by its id; without one, the group's first. */
  | { readonly name: 'document'; readonly groupId: string; readonly documentId?: string }
  /** Propose a new Document (#92). */
  | { readonly name: 'newDocument'; readonly groupId: string }
  /** A Document's change log (#104): every change that passed, newest first. */
  | { readonly name: 'documentLog'; readonly groupId: string; readonly documentId: string }
  | { readonly name: 'propose'; readonly groupId: string; readonly atomId: string }
  | { readonly name: 'priority'; readonly groupId: string }
  | { readonly name: 'proposal'; readonly groupId: string; readonly proposalId: string }
  /**
   * Add a section (#75): after the Atom `after`, in its Document, or at the
   * start of `document` (#92), or of the group's first Document without one.
   * `heading` makes it a section header (1) or a subsection header (2) (#103).
   */
  | {
      readonly name: 'add';
      readonly groupId: string;
      readonly after: string | null;
      readonly document?: string;
      readonly heading?: HeadingLevel;
    }
  | { readonly name: 'remove'; readonly groupId: string; readonly atomId: string }
  /** Move this section (#103). */
  | { readonly name: 'move'; readonly groupId: string; readonly atomId: string }
  /** Protect this section, or change its protection (#116). */
  | { readonly name: 'protect'; readonly groupId: string; readonly atomId: string }
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
  /** Propose removing a member (#115), by their key in the group. */
  | { readonly name: 'removal'; readonly groupId: string; readonly member: string }
  /** The group's Dispatches, newest first (#112). */
  | { readonly name: 'dispatches'; readonly groupId: string }
  /** Send a Dispatch (#112). */
  | { readonly name: 'sendDispatch'; readonly groupId: string }
  /** Reconcile with another group (#114): the card's form. */
  | { readonly name: 'reconcile'; readonly groupId: string }
  /** A coalition's home (#120), by its genesis id. */
  | { readonly name: 'coalition'; readonly coalitionId: string }
  /** One of a coalition's Documents (#120), by its id: today, the coalition's genesis id. */
  | {
      readonly name: 'coalitionDocument';
      readonly coalitionId: string;
      readonly documentId: string;
    }
  /** Propose a change to one of a coalition's sections (#120). */
  | { readonly name: 'coalitionPropose'; readonly coalitionId: string; readonly atomId: string }
  /** Reconcile with another coalition (#122): the card's form, one level up. */
  | { readonly name: 'coalitionReconcile'; readonly coalitionId: string }
  /** A coalition Document's change log (#104). */
  | { readonly name: 'coalitionLog'; readonly coalitionId: string; readonly documentId: string }
  /** A coalition's room (#125). */
  | { readonly name: 'coalitionRoom'; readonly coalitionId: string };

/** A route inside one group. */
export type GroupRoute = Extract<Route, { readonly groupId: string }>;

/** A route inside one coalition (#120). */
export type CoalitionRoute = Extract<Route, { readonly coalitionId: string }>;

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
 * Dispatch (#112), Propose a new Document (#92), Ask what to focus on (#107),
 * and Reconcile with another group (#114).
 */
const FIXED_NAMES = [
  'rules',
  'dissolve',
  'dispatches',
  'sendDispatch',
  'newDocument',
  'priority',
  'reconcile',
] as const;

/** A page {@link FIXED_NAMES} lists. */
type FixedName = (typeof FIXED_NAMES)[number];

/** Each fixed page's path after `#/g/{groupId}/`. */
const FIXED_PATHS: Readonly<Record<FixedName, string>> = {
  rules: 'rules',
  dissolve: 'dissolve',
  dispatches: 'dispatches',
  sendDispatch: 'dispatch/new',
  newDocument: 'doc/new',
  priority: 'priority',
  reconcile: 'reconcile',
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

/** A header's page (#103): after the Atom it names, or, `first`, at the start of the Document it names. */
function headerPage(heading: HeadingLevel, first: boolean): ArgPage {
  return first
    ? idPage(DOCUMENT_ID, (groupId, document) => ({
        name: 'add',
        groupId,
        after: null,
        document,
        heading,
      }))
    : idPage(ATOM_ID, (groupId, after) => ({ name: 'add', groupId, after, heading }));
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
  ['add-header', headerPage(1, false)],
  ['add-subheader', headerPage(2, false)],
  ['add-first-header', headerPage(1, true)],
  ['add-first-subheader', headerPage(2, true)],
  ['remove', idPage(ATOM_ID, (groupId, atomId) => ({ name: 'remove', groupId, atomId }))],
  ['move', idPage(ATOM_ID, (groupId, atomId) => ({ name: 'move', groupId, atomId }))],
  ['protect', idPage(ATOM_ID, (groupId, atomId) => ({ name: 'protect', groupId, atomId }))],
  ['steward', (groupId, arg) => stewardPage(groupId, false, arg)],
  ['recall', (groupId, arg) => stewardPage(groupId, true, arg)],
  ['rules', (groupId, arg) => optInPage(groupId, false, arg)],
  ['narrow', (groupId, arg) => optInPage(groupId, true, arg)],
  ['remove-member', idPage(ID, (groupId, member) => ({ name: 'removal', groupId, member }))],
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
 * A page inside a group: one of the fixed pages, such as `dispatch/new`,
 * `priority` (#107) or `doc/new` (#92), `doc` (the first Document) or `add` (a new first section
 * in it, #75), or `doc/{documentId}` (#92), `add-first/{documentId}` (a new
 * first section in that Document, #92), `propose/{atomId}`, `p/{proposalId}`,
 * `again/{proposalId}`, `add/{atomId}` (a new section after that Atom),
 * `remove/{atomId}` (#75), `add-header/{atomId}`, `add-subheader/{atomId}`,
 * `add-first-header/{documentId}`, `add-first-subheader/{documentId}` and
 * `move/{atomId}` (#103), `steward/{seat}`, `recall/{seat}`, `rules/{optIn}`,
 * `narrow/{optIn}` or `remove-member/{member}` (#115), which a section's own
 * `remove` can't share: an added Atom's id is a Proposal's.
 */
function groupPage(groupId: string, page: string, arg: string | undefined): Route {
  const fixed = FIXED_PAGES.get(arg === undefined ? page : `${page}/${arg}`);
  if (fixed !== undefined) return { name: fixed, groupId };
  const make = arg === undefined ? BARE_PAGES.get(page) : ARG_PAGES.get(page);
  return make?.(groupId, arg ?? '') ?? START;
}

/**
 * The Document id of a change log's path, `doc/{documentId}/log` (#104), from
 * a route's page, its argument and what follows them; null for any other path.
 */
function logOf(page: string | undefined, arg: string | undefined, extra: readonly string[]) {
  const [last, ...more] = extra;
  const fits = page === 'doc' && last === 'log' && more.length === 0;
  return fits && arg !== undefined && DOCUMENT_ID.test(arg) ? arg : null;
}

/** `#/g/{groupId}`, Group home, or one of its pages, the deepest being a change log (#104). */
function groupRoute(rest: readonly string[]): Route {
  const [groupId, page, arg, ...extra] = rest;
  if (groupId === undefined || !ID.test(groupId)) return START;
  if (extra.length > 0) {
    const documentId = logOf(page, arg, extra);
    return documentId === null ? START : { name: 'documentLog', groupId, documentId };
  }
  return page === undefined ? { name: 'group', groupId } : groupPage(groupId, page, arg);
}

/** The pages inside a coalition that take one argument (#120): a Document, and the composer. */
const COALITION_PAGES: ReadonlyMap<string, (coalitionId: string, arg: string) => Route> = new Map([
  [
    'doc',
    (coalitionId: string, arg: string): Route =>
      DOCUMENT_ID.test(arg) ? { name: 'coalitionDocument', coalitionId, documentId: arg } : START,
  ],
  [
    'propose',
    (coalitionId: string, arg: string): Route =>
      ATOM_ID.test(arg) ? { name: 'coalitionPropose', coalitionId, atomId: arg } : START,
  ],
]);

/** The pages inside a coalition that take no argument: its card's form (#122), and its room (#125). */
const COALITION_PLAIN_PAGES: ReadonlyMap<string, 'coalitionReconcile' | 'coalitionRoom'> = new Map([
  ['reconcile', 'coalitionReconcile'],
  ['room', 'coalitionRoom'],
]);

/**
 * `#/c/{coalitionId}`, a coalition's home, or one of its pages:
 * `doc/{documentId}` or `propose/{atomId}` (#120), `doc/{documentId}/log`,
 * a Document's change log (#104), `reconcile`, its card's form (#122), or
 * `room` (#125).
 */
function coalitionRoute(rest: readonly string[]): Route {
  const [coalitionId, page, arg, ...extra] = rest;
  if (coalitionId === undefined || !ID.test(coalitionId)) return START;
  if (extra.length > 0) {
    const documentId = logOf(page, arg, extra);
    return documentId === null ? START : { name: 'coalitionLog', coalitionId, documentId };
  }
  if (page === undefined) return { name: 'coalition', coalitionId };
  const plain = COALITION_PLAIN_PAGES.get(page);
  if (plain !== undefined) return arg === undefined ? { name: plain, coalitionId } : START;
  const open = COALITION_PAGES.get(page);
  return open === undefined || arg === undefined ? START : open(coalitionId, arg);
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

/** A reconcile card's own form (#114): `#reconcile/{seed}`, with no slash after `#`. */
const CARD_PREFIX = '#reconcile/';

/** A follow link's own form (#124): `#follow/{seed}`, with no slash after `#`. */
const FOLLOW_PREFIX = '#follow/';

/**
 * `#reconcile/{seed}` or `#follow/{seed}`: the card's or the follow link's
 * page, named `name`, or Start for anything with more after the seed.
 */
function seedRoute(name: 'card' | 'follow', rest: readonly string[]): Route {
  const [payload] = rest;
  return rest.length === 1 && payload !== undefined && SEGMENT.test(payload)
    ? { name, payload }
    : START;
}

/**
 * The pages that take no argument after `#/`: Create group, Settings (#78),
 * the two sides of linking a device (#96), Choose recovery contacts (#109),
 * and the two sides of recovering with contacts (#118). A linking code never
 * travels in a route: it's shown, scanned or pasted, and held only in
 * memory. Nor does a recovery contact, or a recovery code.
 */
/** A page that takes no argument. */
export type BareRoute = Extract<
  Route,
  {
    readonly name:
      'create' | 'settings' | 'linkNew' | 'linkThis' | 'recovery' | 'recover' | 'helpRecover';
  }
>;

/** Each page that takes no argument, by its path after `#/`. */
const PAGES: ReadonlyMap<string, Route> = new Map<string, Route>([
  ['create', { name: 'create' }],
  ['settings', { name: 'settings' }],
  ['link-new', { name: 'linkNew' }],
  ['link-this', { name: 'linkThis' }],
  ['recovery', { name: 'recovery' }],
  ['recover', { name: 'recover' }],
  ['help-recover', { name: 'helpRecover' }],
  // A card once its seed has left the address bar (#114).
  ['card', { name: 'card', payload: null }],
  // A follow link once its seed has left the address bar (#124).
  ['follow', { name: 'follow', payload: null }],
]);

/** The names of the pages that take no argument. */
const BARE_NAMES: ReadonlySet<Route['name']> = new Set<BareRoute['name']>([
  'create',
  'settings',
  'linkNew',
  'linkThis',
  'recovery',
  'recover',
  'helpRecover',
]);

/** Whether `route` is a page that takes no argument. */
export function isBare(route: Route): route is BareRoute {
  return BARE_NAMES.has(route.name);
}

/** The pages after `#/` that read what follows them: Join, a group, Personal (#93) and a coalition (#120). */
const NESTED: ReadonlyMap<string, (rest: readonly string[]) => Route> = new Map([
  ['join', joinRoute],
  ['g', groupRoute],
  ['me', personalRoute],
  ['c', coalitionRoute],
]);

/** A share link's own form (#105): `#share/{seed}.{publicKey}`, with no slash after `#`. */
const SHARE_PREFIX = '#share/';

/** A front door link's own form (#121): `#door/{address}`, with no slash after `#`. */
const DOOR_PREFIX = '#door/';

/**
 * A link's own route, with no slash after `#`: a share link's page (#105) or
 * a front door (#121), each reading its payload itself, an invite's (spec
 * §3), a reconcile card's (#114) or a follow link's (#124); null for any
 * other hash.
 */
function linkRoute(hash: string): Route | null {
  if (hash.startsWith(SHARE_PREFIX))
    return { name: 'shared', payload: hash.slice(SHARE_PREFIX.length) };
  if (hash.startsWith(DOOR_PREFIX))
    return { name: 'door', payload: hash.slice(DOOR_PREFIX.length) };
  if (hash.startsWith(INVITE_PREFIX)) {
    const rest = hash.slice(INVITE_PREFIX.length).split('/');
    return rest.length === 1 && rest[0] !== '' ? joinRoute(rest) : START;
  }
  if (hash.startsWith(CARD_PREFIX)) {
    return seedRoute('card', hash.slice(CARD_PREFIX.length).split('/'));
  }
  if (hash.startsWith(FOLLOW_PREFIX)) {
    return seedRoute('follow', hash.slice(FOLLOW_PREFIX.length).split('/'));
  }
  return null;
}

/** Reads a `location.hash` value as a route. */
export function parseRoute(hash: string): Route {
  const link = linkRoute(hash);
  if (link !== null) return link;
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

/** What a header's page adds to `add` or `add-first` (#103): nothing for a section. */
function headerSuffix(heading: HeadingLevel | undefined): string {
  if (heading === undefined) return '';
  return heading === 1 ? '-header' : '-subheader';
}

/**
 * An add's path (#75): after its anchor, or at the start of the Document it
 * names (#92), or of the group's first Document when it names none; a
 * header's names its level (#103).
 */
function addPath(route: Extract<Route, { readonly name: 'add' }>): string {
  const suffix = headerSuffix(route.heading);
  if (route.after === null && route.document !== undefined) {
    return `/add-first${suffix}/${route.document}`;
  }
  return `/add${suffix}${idPath(route.after)}`;
}

/**
 * A section composer's path (#75): proposing a change, adding, removing,
 * moving (#103) or protecting a section (#116).
 */
function sectionPath(route: SectionRoute): string {
  switch (route.name) {
    case 'propose':
      return `/propose/${route.atomId}`;
    case 'add':
      return addPath(route);
    case 'remove':
      return `/remove/${route.atomId}`;
    case 'move':
      return `/move/${route.atomId}`;
    case 'protect':
      return `/protect/${route.atomId}`;
  }
}

/** The section composers' routes (#75, #103, #116), whose paths {@link sectionPath} builds. */
type SectionRoute = Extract<
  GroupRoute,
  { readonly name: 'propose' | 'add' | 'remove' | 'move' | 'protect' }
>;

const SECTION_ROUTES: ReadonlySet<string> = new Set([
  'propose',
  'add',
  'remove',
  'move',
  'protect',
]);

/** True for a section composer's route. */
function isSectionRoute(route: GroupRoute): route is SectionRoute {
  return SECTION_ROUTES.has(route.name);
}

/** The path of a page inside a group, after `#/g/{groupId}`. */
function groupPath(route: GroupRoute): string {
  if (isSectionRoute(route)) return sectionPath(route);
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
    case 'removal':
      return `/remove-member/${route.member}`;
    default:
      return pagePath(route);
  }
}

/**
 * The path of a group page that names at most a Document (#92): one of the
 * group's Documents, a Document's change log (#104), or a fixed page.
 */
function pagePath(
  route: Extract<GroupRoute, { readonly name: 'document' | 'documentLog' | FixedName }>,
): string {
  if (route.name === 'documentLog') return `/doc/${route.documentId}/log`;
  return route.name === 'document'
    ? `/doc${idPath(route.documentId ?? null)}`
    : `/${FIXED_PATHS[route.name]}`;
}

/** The `href` of a page inside a coalition (#120). */
function coalitionHref(route: CoalitionRoute): string {
  const home = `#/c/${route.coalitionId}`;
  switch (route.name) {
    case 'coalition':
      return home;
    case 'coalitionDocument':
      return `${home}/doc/${route.documentId}`;
    case 'coalitionPropose':
      return `${home}/propose/${route.atomId}`;
    case 'coalitionReconcile':
      return `${home}/reconcile`;
    case 'coalitionLog':
      return `${home}/doc/${route.documentId}/log`;
    case 'coalitionRoom':
      return `${home}/room`;
  }
}

/** A route outside any group that takes nothing. */
type FixedTop = Extract<
  Route,
  {
    readonly name:
      | 'start'
      | 'create'
      | 'settings'
      | 'personal'
      | 'linkNew'
      | 'linkThis'
      | 'recovery'
      | 'recover'
      | 'helpRecover';
  }
>;

/** Each such route's `href`. */
const TOP_HREFS: Readonly<Record<FixedTop['name'], string>> = {
  start: '#/',
  create: '#/create',
  settings: '#/settings',
  personal: '#/me',
  linkNew: '#/link-new',
  linkThis: '#/link-this',
  recovery: '#/recovery',
  recover: '#/recover',
  helpRecover: '#/help-recover',
};

/** The `href` of a route outside any group or coalition. */
function topHref(route: Exclude<Route, GroupRoute | CoalitionRoute>): string {
  switch (route.name) {
    case 'personalDocument':
      return `#/me/${route.id}`;
    case 'join':
      return joinHref(route.payload);
    case 'card':
      return route.payload === null ? '#/card' : `${CARD_PREFIX}${route.payload}`;
    case 'follow':
      return route.payload === null ? '#/follow' : `${FOLLOW_PREFIX}${route.payload}`;
    case 'shared':
      return `${SHARE_PREFIX}${route.payload}`;
    case 'door':
      return `${DOOR_PREFIX}${route.payload}`;
    default:
      return TOP_HREFS[route.name];
  }
}

/** The `href` of a route, starting with `#`. */
export function routeHref(route: Route): string {
  if ('groupId' in route) return `#/g/${route.groupId}${groupPath(route)}`;
  return 'coalitionId' in route ? coalitionHref(route) : topHref(route);
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
