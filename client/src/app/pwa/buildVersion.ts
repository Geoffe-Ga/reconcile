/**
 * The version of the build this page runs (#513): the precache version its
 * service worker keeps it under, which the build writes in where this names
 * `__RECONCILE_BUILD_VERSION__` (`plugins/buildVersion.ts`). Settings shows
 * it in one quiet line. It never leaves the device.
 */

/** What the build writes in; undeclared in development and tests. */
declare const __RECONCILE_BUILD_VERSION__: string | undefined;

/** This build's version, or null where no build wrote one, as in development and tests. */
export function buildVersion(): string | null {
  return typeof __RECONCILE_BUILD_VERSION__ === 'string' ? __RECONCILE_BUILD_VERSION__ : null;
}
