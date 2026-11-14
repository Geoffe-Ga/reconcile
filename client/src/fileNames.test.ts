/**
 * Two modules whose paths differ only in letter case, or only in `.ts` versus `.tsx`,
 * break the build on a case-insensitive file system (macOS and Windows by default),
 * where the founder builds for deploys. There `import './text/WordDiff'` can resolve
 * to `wordDiff.ts` instead of `WordDiff.tsx`, because TypeScript tries `.ts` first.
 * CI runs on Linux, which is case-sensitive, so nothing else catches it.
 */
import { describe, expect, it } from 'vitest';

/** Every module under src/, by path relative to this file. Lazy: nothing is imported. */
const MODULE_PATHS = Object.keys(import.meta.glob('./**/*.{ts,tsx}'));

/** What an import specifier for `path` looks like to a case-insensitive resolver. */
function importKey(path: string): string {
  return path.replace(/\.tsx?$/, '').toLowerCase();
}

/** Groups of module paths that one import specifier can't tell apart. */
function collisions(paths: readonly string[]): string[][] {
  const byKey = new Map<string, string[]>();
  for (const path of paths) {
    const key = importKey(path);
    byKey.set(key, [...(byKey.get(key) ?? []), path]);
  }
  return [...byKey.values()].filter((group) => group.length > 1);
}

describe('module file names', () => {
  it('finds the modules it checks', () => {
    // The glob leaves out the file that calls it, so check for two others.
    expect(MODULE_PATHS).toContain('./app/App.tsx');
    expect(MODULE_PATHS).toContain('./app/text/WordDiff.tsx');
  });

  it('flags paths that differ only in case or in .ts versus .tsx', () => {
    expect(collisions(['./a/Foo.tsx', './a/foo.ts', './a/bar.ts'])).toEqual([
      ['./a/Foo.tsx', './a/foo.ts'],
    ]);
    expect(collisions(['./a/x.ts', './a/x.tsx'])).toEqual([['./a/x.ts', './a/x.tsx']]);
    expect(collisions(['./a/foo.ts', './a/foo.test.ts', './b/foo.ts'])).toEqual([]);
  });

  it('gives every module under src/ an import path no other module shares, ignoring case', () => {
    expect(collisions(MODULE_PATHS)).toEqual([]);
  });
});
