/**
 * The cache of public entry vectors (#477; ADR-0080 §5, §8).
 *
 * Embedding claims is nearly all of a run's time (#476), and a shelf entry's
 * text is public and changes rarely, so its vectors are kept on the device
 * and a refresh embeds only what is new. ADR-0080 §5 allows exactly this:
 * "Vectors of public shelf entries may sit in an ordinary cache."
 *
 * - A record is keyed by **entry id**, and holds the **model** that made it,
 *   the entry's **claims** as split, and one vector per claim. It is reused
 *   only while all three still match; otherwise the entry is embedded again.
 * - After each run, the store keeps only the run's entries (a run's entries
 *   are the shelf) under the run's model: an entry that left the shelf, or a
 *   vector of another model, is dropped.
 * - An embedder that names no model (`Embedder.model`) keeps nothing.
 * - **Nothing of the reader's goes in:** not their text, not their vectors,
 *   not a score. This module is handed only entries' public claims.
 *
 * Storage is a narrow port, {@link VectorStore}, so the pipeline never
 * reaches a database itself. The worker hands it {@link indexedDbVectorStore}:
 * an IndexedDB database of its own, `reconcile-bedfellows-vectors`, outside
 * the app's store and vault, since it holds only public text's vectors. Erase
 * deletes it with every other database the origin holds, and it closes
 * itself when asked to, so it never blocks that. IndexedDB rather than Cache
 * Storage: it keeps `Float32Array`s as they are, with no JSON in between, and
 * the service worker's cache pruning never reaches it. A store that fails, as
 * IndexedDB can in a private window, costs only the reuse: the run embeds
 * everything and answers as before.
 */
import type { Embedder, Vector } from './types';

/** The IndexedDB database the worker keeps entry vectors in. */
export const VECTOR_DATABASE = 'reconcile-bedfellows-vectors';

/** Its one object store, keyed by entry id. */
const ENTRIES = 'entries';

/** Sentences embedded per call, so a cancel lands between calls. */
export const CHUNK = 64;

/** One entry's kept vectors. */
export interface StoredVectors {
  readonly entryId: string;
  /** The model that made them (`Embedder.model`). */
  readonly model: string;
  /** The entry's claims, as split, each the vector at its index. */
  readonly claims: readonly string[];
  readonly vectors: readonly Float32Array[];
}

/** Where entry vectors are kept: the narrow port the worker supplies. */
export interface VectorStore {
  /** The records kept for `entryIds`; an id with none is absent from the map. */
  read(entryIds: readonly string[]): Promise<ReadonlyMap<string, StoredVectors>>;
  /** Keeps `records`, each replacing any kept under its entry id. */
  write(records: readonly StoredVectors[]): Promise<void>;
  /** Drops every record whose entry isn't in `entryIds` or whose model isn't `model`. */
  keepOnly(entryIds: readonly string[], model: string): Promise<void>;
}

/** An entry's id and its claims, as split. */
export interface EntryClaims {
  readonly id: string;
  readonly claims: readonly string[];
}

/** How {@link entryVectors} runs. */
export interface EntryVectorOptions {
  /** Where to keep vectors; without one, nothing is kept. */
  readonly store?: VectorStore | undefined;
  /** Stops the run between chunks. */
  readonly signal?: AbortSignal | undefined;
  /** Sentences per embed call ({@link CHUNK}). */
  readonly chunk?: number;
}

/** Rejects with an AbortError once `signal` is aborted. */
export function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('The Bedfellows run was cancelled.', 'AbortError');
  }
}

/** Whether `a` and `b` hold the same strings in the same order. */
function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** The kept record for `entry`, when it was made by `model` from the same claims. */
function reusable(
  entry: EntryClaims,
  kept: ReadonlyMap<string, StoredVectors>,
  model: string | undefined,
): StoredVectors | undefined {
  const record = kept.get(entry.id);
  if (record === undefined || record.model !== model) return undefined;
  if (!same(record.claims, entry.claims) || record.vectors.length !== entry.claims.length) {
    return undefined;
  }
  return record;
}

/**
 * Each of `sentences` embedded, `chunk` at a time, checking `signal` before
 * each call. It keeps nothing: the pipeline embeds the reader's claims with it
 * too, and those vectors stay in memory.
 */
export async function embedInChunks(
  sentences: readonly string[],
  embedder: Embedder,
  chunk: number,
  signal: AbortSignal | undefined,
): Promise<Map<string, Float32Array>> {
  const vectors = new Map<string, Float32Array>();
  for (let start = 0; start < sentences.length; start += chunk) {
    stopIfAborted(signal);
    const part = sentences.slice(start, start + chunk);
    const embedded = await embedder.embed(part);
    part.forEach((sentence, i) => {
      vectors.set(sentence, Float32Array.from(embedded[i] ?? []));
    });
  }
  return vectors;
}

/**
 * Each entry's claim vectors, in its claims' order: kept ones where the store
 * holds them for this model and these claims, the rest embedded (each
 * distinct sentence once) and kept. Afterwards the store keeps only these
 * entries, under this model.
 *
 * @throws {DOMException} an AbortError, between chunks, once `signal` is aborted.
 */
export async function entryVectors(
  entries: readonly EntryClaims[],
  embedder: Embedder,
  options: EntryVectorOptions = {},
): Promise<Map<string, Vector[]>> {
  const { model } = embedder;
  const store = model === undefined ? undefined : options.store;
  const ids = entries.map((entry) => entry.id);
  const kept = await readKept(store, ids);
  const missing = entries.filter((entry) => reusable(entry, kept, model) === undefined);
  const sentences = [...new Set(missing.flatMap((entry) => entry.claims))];
  const fresh = await embedInChunks(sentences, embedder, options.chunk ?? CHUNK, options.signal);
  const result = new Map<string, Vector[]>();
  const records: StoredVectors[] = [];
  for (const entry of entries) {
    const found = reusable(entry, kept, model);
    const vectors = found?.vectors ?? entry.claims.map((claim) => fresh.get(claim) ?? empty);
    result.set(entry.id, [...vectors]);
    if (found === undefined) records.push(recordOf(entry, model, vectors));
  }
  if (store !== undefined && model !== undefined) await keep(store, records, ids, model);
  return result;
}

/** No vector: what a claim the model gave nothing for is matched with. */
const empty = new Float32Array();

/** The record that keeps `entry`'s `vectors`, made by `model`. */
function recordOf(
  entry: EntryClaims,
  model: string | undefined,
  vectors: readonly Float32Array[],
): StoredVectors {
  return {
    entryId: entry.id,
    model: model ?? '',
    claims: [...entry.claims],
    vectors: [...vectors],
  };
}

/** What `store` keeps for `ids`: nothing without a store, or when it fails to read. */
async function readKept(
  store: VectorStore | undefined,
  ids: readonly string[],
): Promise<ReadonlyMap<string, StoredVectors>> {
  if (store === undefined) return new Map();
  return store.read(ids).catch(() => new Map<string, StoredVectors>());
}

/** Keeps `records`, then only the shelf's entries under `model`; a failing store costs only the reuse. */
async function keep(
  store: VectorStore,
  records: readonly StoredVectors[],
  ids: readonly string[],
  model: string,
): Promise<void> {
  await store.write(records).catch(() => undefined);
  await store.keepOnly(ids, model).catch(() => undefined);
}

/** A store in memory, for tests and for a device without IndexedDB; `records` lists it by entry id. */
export function memoryVectorStore(): VectorStore & { records(): StoredVectors[] } {
  const kept = new Map<string, StoredVectors>();
  return {
    read: (entryIds) =>
      Promise.resolve(
        new Map(
          entryIds.flatMap((id) => {
            const record = kept.get(id);
            return record === undefined ? [] : [[id, record] as const];
          }),
        ),
      ),
    write: (records) => {
      for (const record of records) kept.set(record.entryId, record);
      return Promise.resolve();
    },
    keepOnly: (entryIds, model) => {
      const shelf = new Set(entryIds);
      for (const [id, record] of kept) {
        if (!shelf.has(id) || record.model !== model) kept.delete(id);
      }
      return Promise.resolve();
    },
    records: () => [...kept.values()].sort((a, b) => (a.entryId < b.entryId ? -1 : 1)),
  };
}

/** Settles when `request` succeeds, with its result, or rejects with its error. */
function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB refused a request.'));
    };
  });
}

/** Settles when `transaction` completes, or rejects when it fails or aborts. */
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    const failed = () => {
      reject(transaction.error ?? new Error('IndexedDB aborted a transaction.'));
    };
    transaction.onerror = failed;
    transaction.onabort = failed;
  });
}

/**
 * The worker's store: database `name` in `factory`, opened on first use. It
 * closes itself when another connection asks to delete or upgrade it (an
 * Erase), and opens afresh on its next use.
 */
export function indexedDbVectorStore(factory: IDBFactory, name = VECTOR_DATABASE): VectorStore {
  let opening: Promise<IDBDatabase> | null = null;

  /** The open database. */
  function open(): Promise<IDBDatabase> {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(ENTRIES, { keyPath: 'entryId' });
      };
      settled(request).then((db) => {
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      }, reject);
    }).catch((error: unknown) => {
      opening = null;
      throw error;
    });
    return opening;
  }

  /** The entries store in a new transaction of `mode`. */
  async function entriesIn(mode: IDBTransactionMode) {
    const transaction = (await open()).transaction(ENTRIES, mode);
    return { store: transaction.objectStore(ENTRIES), done: completed(transaction) };
  }

  return {
    read: async (entryIds) => {
      const { store, done } = await entriesIn('readonly');
      const found = await Promise.all(
        entryIds.map((id) => settled(store.get(id) as IDBRequest<StoredVectors | undefined>)),
      );
      await done;
      return new Map(
        found.flatMap((record) =>
          record === undefined ? [] : [[record.entryId, record] as const],
        ),
      );
    },
    write: async (records) => {
      const { store, done } = await entriesIn('readwrite');
      for (const record of records) store.put(record);
      await done;
    },
    keepOnly: async (entryIds, model) => {
      const shelf = new Set(entryIds);
      const { store, done } = await entriesIn('readwrite');
      const all = await settled(store.getAll() as IDBRequest<StoredVectors[]>);
      for (const record of all) {
        if (!shelf.has(record.entryId) || record.model !== model) store.delete(record.entryId);
      }
      await done;
    },
  };
}
