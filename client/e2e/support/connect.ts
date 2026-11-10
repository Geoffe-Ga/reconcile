/**
 * Requests sent from the page itself, for e2e/csp.spec.ts (#119): what the
 * deploy CSP's `connect-src` lets through and what it blocks. This is the one
 * file outside src/net/ that may call `fetch` (eslint.config.js), because
 * the request is what the spec tests, from inside the page the CSP guards.
 */
import type { Page } from '@playwright/test';

/** What a request from the page got: the status it was answered with, or blocked. */
export type Connected = number | 'blocked';

/**
 * POSTs a small JSON body from `page` to each of `urls`, as the chat bot posts
 * (no cookie, no referrer, no redirect), and reports what each got.
 */
export function connectFromPage(page: Page, urls: readonly string[]): Promise<Connected[]> {
  return page.evaluate(
    (targets) =>
      Promise.all(
        targets.map(async (url): Promise<Connected> => {
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{"content":"x"}',
              credentials: 'omit',
              referrerPolicy: 'no-referrer',
              redirect: 'error',
            });
            return response.status;
          } catch {
            return 'blocked';
          }
        }),
      ),
    urls,
  );
}
