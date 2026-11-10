/**
 * What an IndexedDB database holds, read raw for privacy tests: every key and
 * value in every object store, as text, with every byte array alongside. A
 * test then checks that a group's words, ids, secret or records are gone
 * (#77, #108).
 */
import { openDB } from 'idb';

/** Every key and value in every object store of the database `name`, as text, with its bytes alongside. */
export async function scanDb(name: string): Promise<{ text: string; bytes: Uint8Array[] }> {
  const db = await openDB(name);
  const parts: string[] = [];
  const bytes: Uint8Array[] = [];
  const walk = (value: unknown): void => {
    if (ArrayBuffer.isView(value)) {
      const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      bytes.push(Uint8Array.from(view));
      parts.push(new TextDecoder().decode(view));
    } else if (Object.prototype.toString.call(value) === '[object Map]') {
      for (const entry of (value as Map<unknown, unknown>).entries()) walk(entry);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        parts.push(key);
        walk(item);
      }
    } else {
      parts.push(String(value));
    }
  };
  for (const storeName of db.objectStoreNames) {
    walk(await db.getAllKeys(storeName));
    walk(await db.getAll(storeName));
  }
  db.close();
  return { text: parts.join('\n'), bytes };
}

/** True when `needle` appears, byte for byte, inside any of `haystack`. */
export function containsBytes(haystack: readonly Uint8Array[], needle: Uint8Array): boolean {
  return haystack.some((bytes) =>
    bytes.some((_, start) => needle.every((byte, i) => bytes[start + i] === byte)),
  );
}
