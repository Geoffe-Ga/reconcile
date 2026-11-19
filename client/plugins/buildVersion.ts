/**
 * The build's version in the page (#513), so Settings can name the build a
 * device runs and the founder can compare devices before a protocol change.
 *
 * It is the service worker's own precache version (`plugins/serviceWorker.ts`),
 * not a second id: the hash of every file the build writes, which also names
 * the worker's cache. That hash covers the page's chunks, so it can't be
 * defined before they're built. The page names the placeholder instead
 * (`src/app/pwa/buildVersion.ts`), the version is hashed over the chunks as
 * they stand, and then this writes it in. The same build always gives the
 * same version, and any changed file changes it. A chunk's file name hashes
 * its code before the version is written in, so a build that changes only
 * other files keeps the name; the worker revalidates every file at install,
 * so it still fetches the new bytes.
 */

/** The global `src/app/pwa/buildVersion.ts` reads, which the build replaces with the version. */
export const VERSION_PLACEHOLDER = '__RECONCILE_BUILD_VERSION__';

/** `code` with every mention of {@link VERSION_PLACEHOLDER} replaced by `version`, as a string. */
export function stampVersion(code: string, version: string): string {
  return code.split(VERSION_PLACEHOLDER).join(JSON.stringify(version));
}
