/**
 * In-memory drafts for screen tests: `GroupDrafts` over a Map, with every call
 * recorded. Tests of the stored drafts themselves use the real store on
 * fake-indexeddb instead.
 */
import { vi } from 'vitest';

import type { Draft, GroupDrafts } from '../store/drafts';

/** One group's drafts in memory, and the Map they live in. */
export function memoryDrafts(initial: Readonly<Record<string, Draft>> = {}) {
  const shelf = new Map(Object.entries(initial));
  const drafts = {
    load: vi.fn((target: string) => Promise.resolve(shelf.get(target))),
    save: vi.fn((target: string, draft: Draft) => {
      shelf.set(target, draft);
      return Promise.resolve();
    }),
    clear: vi.fn((target: string) => {
      shelf.delete(target);
      return Promise.resolve();
    }),
  } satisfies GroupDrafts;
  return { drafts, shelf };
}
