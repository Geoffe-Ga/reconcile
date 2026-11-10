/**
 * Persistent storage (ADR-0005, ADR-0029): once the gate is open and the
 * pilot notice accepted, the app asks the browser not to clear its data when
 * the device runs low on space, and Start says so quietly when it may.
 *
 * Safari and Chrome answer without asking the person, from signals such as
 * installation and use, so asking again later can turn a no into a yes.
 */

/** What the browser said: it keeps the data, it may clear it, or it can't be asked. */
export type Persistence = 'granted' | 'denied' | 'unavailable';

/** The one `StorageManager` method used, as an insecure page or an old browser may lack it. */
export interface PersistentStorage {
  readonly persist?: () => Promise<boolean>;
}

/** The browser's storage manager, when this page has one. */
function browserStorage(): PersistentStorage | undefined {
  return 'storage' in navigator ? navigator.storage : undefined;
}

/** Asks for persistent storage. It never throws: a failure reads as `unavailable`. */
export async function requestPersistence(
  storage: PersistentStorage | undefined = browserStorage(),
): Promise<Persistence> {
  if (storage?.persist === undefined) return 'unavailable';
  try {
    return (await storage.persist()) ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}
