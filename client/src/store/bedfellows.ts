/**
 * The Bedfellows history (#480; ADR-0080 §5): which shelf entries Bedfellows
 * showed and how the reader marked them, with the dial's position, kept on
 * this one device, sealed, for at most 30 days.
 *
 * **What it keeps.** Per shown entry, its id, the day it was first shown and
 * a mark (`common-ground`, `too-far` or none); once per device, the dial's
 * step, the week of its last step and the rotation seed. No entry text, no
 * reason, no score, no vector, no word of the reader's and no group's name,
 * so leaving a group or a group dissolving changes nothing here.
 *
 * **Where.** Only inside the vault: `Store.keepBedfellows` seals it whole,
 * entry ids included, into one slot of a fixed size beside the key vault
 * (`../crypto/history.ts`, `./db.ts`). Every vault has that slot from the day
 * it is made, empty or not, so a locked device shows no sign that Bedfellows
 * was ever opened. A device with no vault (ADR-0030) writes nothing: the
 * dial, the seed and the marks live in this session's memory and end with
 * the page. No snapshot, backup file, relay backup or device link reads the
 * slot, and a vault Restore replaces takes it with it, so a restored or
 * linked device starts with no history and the dial at 0.
 *
 * **When it's written.** Never on a tap. {@link BedfellowsHistory} holds the
 * session's changes in memory and `flush` writes them, at most once, when
 * the view closes or the app is hidden ({@link flushWhenHidden}). The vault
 * has no scheduled-write mechanism yet (ADR-0046 is deferred by ADR-0073),
 * so these batched writes stand in for it. While the vault is locked a write
 * is refused, and the change stays in memory, never in the clear.
 *
 * **Expiry.** A record goes 30 days after the start of the day it was first
 * shown, or as soon as its entry is no longer on the shelf, whichever comes
 * first: checked each time Bedfellows opens, and by time alone after each
 * sync pass (`Store.sweepBedfellows`). Days come from the device's clock,
 * not the relay's: nothing here is shared, so no one else's clock matters,
 * and the worst a wrong clock does is forget a record early, or keep one
 * until the next sweep under an honest clock.
 *
 * **Marks** are private: never shown to anyone, counted or sent. A mark
 * nudges the dial one step (#479's `nudge`): Common ground out, Too far in,
 * but at most once a view (the founder's decision of 2026-11-19, after
 * #481's year found a reader who marks every strange entry Too far pulled
 * back to the dial's start, a step for each mark). A view is one
 * {@link BedfellowsHistory.open}: the first mark after it that nudges spends
 * the view's nudge, and later marks until the next open are kept without
 * moving the dial. The count lives in the session's memory, not the sealed
 * slot, so reopening Bedfellows (or reloading the page) starts a new view.
 * An entry marked Too far goes to the pipeline as one to leave out. Taking a
 * mark back, or marking the same way again, leaves the dial where it is and
 * the view's nudge unspent. Nothing else is ever a signal: not
 * time spent, opening an entry, Ask to join, Propose reconciling, votes,
 * membership or follows.
 */
import { nextDial, nudge, resetDial, setDial, weekOf } from '../bedfellows/clock';
import { clampDial, TOP } from '../bedfellows/mix';
import { MAX_HISTORY_PLAINTEXT } from '../crypto/history';
import { randomBytes, type Random } from '../crypto/random';

/** A reader's private mark on an entry Bedfellows showed. */
export type Mark = 'common-ground' | 'too-far';

/** One entry Bedfellows showed: its id, the day it was first shown, and the reader's mark. */
export interface ShownEntry {
  readonly id: string;
  /** Days from 1970-01-01 (UTC) to the day it was first shown. */
  readonly day: number;
  readonly mark?: Mark;
}

/** Everything the history keeps. */
export interface BedfellowsState {
  /** The dial's step, 0 to `TOP`. */
  readonly dial: number;
  /** The week the dial last stepped (or was first opened), or null before the first view. */
  readonly lastStepWeek: number | null;
  /** The seed each view turns its tiers by, or null until the first view draws one. */
  readonly seed: number | null;
  /** Each entry shown, once. */
  readonly shown: readonly ShownEntry[];
}

/** The history of a device that never opened Bedfellows, or cleared it. */
export const EMPTY_HISTORY: BedfellowsState = {
  dial: 0,
  lastStepWeek: null,
  seed: null,
  shown: [],
};

/** How long a record lasts, in days from the start of the day it was first shown. */
export const HISTORY_DAYS = 30;

/** The longest entry id the history keeps. */
const MAX_ID = 128;

/** The plaintext's format. */
const FORMAT = 1;

/** The plaintext's fields, exactly. */
const FIELDS = ['dial', 'format', 'seed', 'shown', 'week'];

/** What {@link HistoryStore.subscribe}'s listeners hear once the history is cleared: never a group id. */
export const BEDFELLOWS_CLEARED = 'bedfellows-cleared';

/** Milliseconds in a day. */
const DAY = 86_400_000;

const MARKS: readonly Mark[] = ['common-ground', 'too-far'];

/** One record as the plaintext lists it. */
function recordJson({ id, day, mark }: ShownEntry): unknown[] {
  return mark === undefined ? [id, day] : [id, day, mark];
}

/** The plaintext of `state`, with `shown` in place of its records. */
function spelled(state: BedfellowsState, shown: readonly string[]): string {
  const head = JSON.stringify({
    format: FORMAT,
    dial: clampDial(state.dial),
    week: state.lastStepWeek,
    seed: state.seed,
  }).slice(0, -1);
  return `${head},"shown":[${shown.join(',')}]}`;
}

/**
 * `state` as the sealed slot's plaintext, UTF-8 JSON. When its records don't
 * all fit the slot, the oldest go first: the history forgets early rather
 * than grow, so its size never says how much the reader saw.
 *
 * @throws {RangeError} when an entry id is empty or longer than 128 characters.
 */
export function encodeHistory(state: BedfellowsState): Uint8Array<ArrayBuffer> {
  if (state.shown.some(({ id }) => id === '' || id.length > MAX_ID)) {
    throw new RangeError('An entry id is 1 to 128 characters.');
  }
  const encoder = new TextEncoder();
  const records = state.shown.map((entry) => JSON.stringify(recordJson(entry)));
  // Newest first, so the room left goes to the newest records.
  const order = state.shown
    .map((entry, i) => ({ day: entry.day, i }))
    .sort((a, b) => b.day - a.day || a.i - b.i);
  let room = MAX_HISTORY_PLAINTEXT - encoder.encode(spelled(state, [])).length;
  const kept = new Set<number>();
  for (const { i } of order) {
    const size = encoder.encode(records[i]).length + 1;
    if (size > room) break;
    room -= size;
    kept.add(i);
  }
  const shown = records.filter((_, i) => kept.has(i));
  return Uint8Array.from(encoder.encode(spelled(state, shown)));
}

/** Whether `value` is a whole number from `min` to `max`. */
function wholeIn(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** One record in `value`, or null when it doesn't check out. */
function recordIn(value: unknown): ShownEntry | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return null;
  const [id, day, mark] = value as unknown[];
  if (typeof id !== 'string' || id === '' || id.length > MAX_ID) return null;
  if (!wholeIn(day, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (mark === undefined) return { id, day };
  return MARKS.includes(mark as Mark) ? { id, day, mark: mark as Mark } : null;
}

/** Each record in `value`, each entry once, or null when any doesn't check out. */
function recordsIn(value: unknown): ShownEntry[] | null {
  if (!Array.isArray(value)) return null;
  const records = value.map(recordIn);
  if (records.some((record) => record === null)) return null;
  const shown = records.filter((record) => record !== null);
  return new Set(shown.map(({ id }) => id)).size === shown.length ? shown : null;
}

/** `value` when it is null or a whole number from 0 to `max`, else undefined. */
function optionalWhole(value: unknown, max: number): number | null | undefined {
  if (value === null) return null;
  return wholeIn(value, 0, max) ? value : undefined;
}

/** The JSON object `bytes` spell in UTF-8, or null. */
function objectIn(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof json === 'object' && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The history a sealed slot's plaintext holds, or null when anything in it doesn't check out. */
export function decodeHistory(bytes: Uint8Array): BedfellowsState | null {
  const json = objectIn(bytes);
  if (json?.format !== FORMAT) return null;
  if (Object.keys(json).sort().join() !== FIELDS.join()) return null;
  const week = optionalWhole(json.week, Number.MAX_SAFE_INTEGER);
  const seed = optionalWhole(json.seed, 0xffff_ffff);
  const shown = recordsIn(json.shown);
  if (!wholeIn(json.dial, 0, TOP) || week === undefined || seed === undefined || shown === null) {
    return null;
  }
  return { dial: json.dial, lastStepWeek: week, seed, shown };
}

/**
 * `state` without each record 30 days past the start of its first day at
 * `now`, a device clock reading in milliseconds, nor, given `shelf`, any whose
 * entry isn't on it. The same object when nothing went.
 */
export function expireHistory(
  state: BedfellowsState,
  now: number,
  shelf?: ReadonlySet<string>,
): BedfellowsState {
  const shown = state.shown.filter(
    ({ id, day }) => now < (day + HISTORY_DAYS) * DAY && (shelf === undefined || shelf.has(id)),
  );
  return shown.length === state.shown.length ? state : { ...state, shown };
}

/** What a store does with the history: `Store`'s side of it (`./db.ts`). */
export interface HistoryStore {
  /**
   * The history sealed in the vault, or null when the device has no vault.
   *
   * @throws {VaultLocked} when it has one this session hasn't opened.
   */
  readBedfellows(): Promise<BedfellowsState | null>;
  /**
   * Seal `state` into the vault's slot, in place of what it held: true once
   * written, false when the device has no vault, which writes nothing.
   *
   * @throws {VaultLocked} when it has one this session hasn't opened.
   */
  keepBedfellows(state: BedfellowsState): Promise<boolean>;
  /** Overwrite the slot with an empty history, and tell listeners {@link BEDFELLOWS_CLEARED}. */
  clearBedfellows(): Promise<void>;
  /** Hear each change; returns the way to stop. */
  subscribe(listener: (changed: string) => void): () => void;
}

/** What a view needs of the history: the pipeline's inputs and the dial. */
export interface HistoryView {
  readonly dial: number;
  readonly seed: number;
  /** Every entry shown and not yet forgotten, which the pipeline ranks after unseen ones. */
  readonly shown: readonly string[];
  /** Every entry marked Too far, which the pipeline leaves out. */
  readonly leaveOut: readonly string[];
  /** Each entry's mark, for the view to show the reader their own. */
  readonly marks: ReadonlyMap<string, Mark>;
}

/** One session's hold on the history: changes stay in memory until {@link BedfellowsHistory.flush}. */
export interface BedfellowsHistory {
  /**
   * Bedfellows opens on a shelf of `shelf`'s entry ids: forget what expired or
   * left it, step the dial for this week (#479), and read the view's inputs.
   * Each open starts a new view, with one nudge for its marks to spend.
   *
   * @throws {VaultLocked} on a device with a vault this session hasn't opened.
   */
  open(shelf: readonly string[]): Promise<HistoryView>;
  /** The view's inputs as they stand. */
  read(): Promise<HistoryView>;
  /** The view showed `ids`: each not yet recorded is, as first shown today. */
  showed(ids: readonly string[]): Promise<void>;
  /**
   * Mark `id` (recording it as shown today if it isn't); null takes a mark
   * back. A new mark nudges the dial if it's the first to since the last
   * {@link BedfellowsHistory.open}: at most one nudge a view.
   */
  mark(id: string, mark: Mark | null): Promise<void>;
  /** The reader moves the dial to `step`. */
  setDial(step: number): Promise<void>;
  /** The reader resets the dial to 0. */
  resetDial(): Promise<void>;
  /** Forget what expired, and every record whose entry isn't in `shelf`. */
  sweep(shelf: readonly string[]): Promise<void>;
  /**
   * Write the session's changes, once, if there are any. Without a vault it
   * writes nothing.
   *
   * @throws {VaultLocked} while the vault is locked; the changes stay in memory.
   */
  flush(): Promise<void>;
  /** Forget every record, the dial and the seed, here and in the vault. */
  clear(): Promise<void>;
  /** Stop listening to the store. */
  close(): void;
}

/** How a session's history reads time and draws its seed; a test hands in its own. */
export interface HistoryOptions {
  /** The device clock, in milliseconds. */
  readonly now?: () => number;
  /** Random bytes for the seed. */
  readonly random?: Random;
}

/** The UTC calendar date of `ms`, YYYY-MM-DD. */
function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A seed drawn from four random bytes, read big-endian. */
function drawSeed(random: Random): number {
  return random(4).reduce((value, byte) => value * 256 + byte, 0);
}

/** `state`'s view, its seed drawn. */
function viewOf(state: BedfellowsState & { readonly seed: number }): HistoryView {
  const marks = new Map(state.shown.flatMap(({ id, mark }) => (mark ? [[id, mark] as const] : [])));
  return {
    dial: state.dial,
    seed: state.seed,
    shown: state.shown.map(({ id }) => id),
    leaveOut: [...marks].filter(([, mark]) => mark === 'too-far').map(([id]) => id),
    marks,
  };
}

/** `shown` with `id` marked `mark`, recorded as first shown on `day` if it wasn't. */
function withMark(
  shown: readonly ShownEntry[],
  id: string,
  mark: Mark | null,
  day: number,
): ShownEntry[] {
  const held = shown.find((entry) => entry.id === id);
  const record = { id, day: held?.day ?? day, ...(mark === null ? {} : { mark }) };
  return held === undefined
    ? [...shown, record]
    : shown.map((entry) => (entry === held ? record : entry));
}

/** Whether `mark` replacing `before` on an entry nudges: a new mark does, a taken-back or repeated one doesn't. */
function nudges(before: Mark | undefined, mark: Mark | null): mark is Mark {
  return mark !== null && mark !== before;
}

/**
 * `state` once Bedfellows opens in `week`: a first view notes the week and
 * leaves the dial at its start; a later week steps it once (#479's
 * `nextDial`); the same week changes nothing, and hands back `state` itself.
 */
function stepFor<State extends BedfellowsState>(state: State, week: number): State {
  const last = state.lastStepWeek;
  if (last !== null && week <= last) return state;
  const dial = last === null ? state.dial : nextDial(state.dial, last, week, true);
  return { ...state, dial, lastStepWeek: week };
}

/**
 * The session's history on `store`. It reads the store once, on first use;
 * every change after stays in memory until `flush`.
 */
export function createBedfellowsHistory(
  store: HistoryStore,
  options: HistoryOptions = {},
): BedfellowsHistory {
  const now = options.now ?? Date.now;
  const random = options.random ?? randomBytes;
  let state: BedfellowsState | null = null;
  let dirty = false;
  /** Whether a mark has nudged the dial since the last open: at most one nudge a view. */
  let nudged = false;

  const stop = store.subscribe((changed) => {
    if (changed !== BEDFELLOWS_CLEARED) return;
    state = EMPTY_HISTORY;
    dirty = false;
  });

  /** The state, read from the store on first use, with a seed drawn if it has none. */
  async function held(): Promise<BedfellowsState & { readonly seed: number }> {
    state ??= (await store.readBedfellows()) ?? EMPTY_HISTORY;
    if (state.seed !== null) return { ...state, seed: state.seed };
    const seeded = { ...state, seed: drawSeed(random) };
    change(seeded);
    return seeded;
  }

  /** Puts `next` in place, noting a change to write. */
  function change(next: BedfellowsState): void {
    if (next !== state) dirty = true;
    state = next;
  }

  const today = (): number => Math.floor(now() / DAY);

  async function sweep(shelf: readonly string[]): Promise<void> {
    change(expireHistory(await held(), now(), new Set(shelf)));
  }

  return {
    async open(shelf) {
      nudged = false;
      await sweep(shelf);
      const current = await held();
      const stepped = stepFor(current, weekOf(dateOf(now())));
      if (stepped !== current) change(stepped);
      return viewOf(stepped);
    },
    async read() {
      return viewOf(await held());
    },
    async showed(ids) {
      const current = await held();
      const known = new Set(current.shown.map(({ id }) => id));
      const fresh = [...new Set(ids)].filter((id) => !known.has(id));
      if (fresh.length === 0) return;
      const day = today();
      change({ ...current, shown: [...current.shown, ...fresh.map((id) => ({ id, day }))] });
    },
    async mark(id, mark) {
      const current = await held();
      const before = current.shown.find((entry) => entry.id === id)?.mark;
      let dial = current.dial;
      if (!nudged && nudges(before, mark)) {
        nudged = true;
        dial = nudge(dial, mark === 'common-ground' ? 'out' : 'in');
      }
      change({ ...current, dial, shown: withMark(current.shown, id, mark, today()) });
    },
    async setDial(step) {
      change({ ...(await held()), dial: setDial(step) });
    },
    async resetDial() {
      change({ ...(await held()), dial: resetDial() });
    },
    sweep,
    async flush() {
      if (state === null || !dirty) return;
      const writing = state;
      await store.keepBedfellows(writing);
      if (state === writing) dirty = false;
    },
    async clear() {
      await store.clearBedfellows();
      state = EMPTY_HISTORY;
      dirty = false;
    },
    close() {
      stop();
    },
  };
}

/** Where {@link flushWhenHidden} listens, and how it reads whether the page is hidden. */
export interface PageEvents {
  readonly target: EventTarget;
  readonly visibility: () => DocumentVisibilityState;
}

/** The browser's own: the window, and the document's visibility. */
function browserPage(): PageEvents {
  return { target: window, visibility: () => document.visibilityState };
}

/**
 * Flush `history` each time the app is hidden or the page goes away, so a
 * session's marks reach the vault in one write rather than on each tap. A
 * refused flush (a locked vault) keeps its changes in memory and says
 * nothing. Returns the way to stop.
 */
export function flushWhenHidden(
  history: Pick<BedfellowsHistory, 'flush'>,
  page: PageEvents = browserPage(),
): () => void {
  const flush = (): void => {
    history.flush().catch(() => undefined);
  };
  const onVisibility = (): void => {
    if (page.visibility() === 'hidden') flush();
  };
  page.target.addEventListener('visibilitychange', onVisibility);
  page.target.addEventListener('pagehide', flush);
  return () => {
    page.target.removeEventListener('visibilitychange', onVisibility);
    page.target.removeEventListener('pagehide', flush);
  };
}
