/**
 * What every e2e test runs on: a fresh run of the real relay (`relay.ts`),
 * and browser profiles that fail the test on any CSP violation.
 */
import {
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  test as base,
} from '@playwright/test';

import { type RunningRelay, startRelay } from './relay';

/** The name the init script reports CSP violations to, exposed on every page. */
const REPORT_VIOLATION = 'e2eReportCspViolation';

/** One person: a browser profile of their own, and the page they use. */
export interface Person {
  readonly name: string;
  readonly page: Page;
}

/** Opens a new profile for `name`; the fixture closes it after the test. */
export type OpenProfile = (name: string, options?: BrowserContextOptions) => Promise<Person>;

/**
 * Runs in every page before the app: sends each `securitypolicyviolation` to
 * the test. Playwright serializes it into the page, so it reads nothing else.
 */
function recordCspViolations(report: string): void {
  window.addEventListener(
    'securitypolicyviolation',
    (event) => {
      const send = Reflect.get(window, report) as (line: string) => Promise<void>;
      void send(
        `${event.violatedDirective} blocked ${event.blockedURI || 'inline'} (${event.sourceFile})`,
      );
    },
    true,
  );
}

export const test = base.extend<{ relay: RunningRelay; openProfile: OpenProfile }>({
  // Every test gets the relay, started before it and stopped after it. It waits for
  // the relay's health check through `request`.
  relay: [
    async ({ request }, provide) => {
      const relay = await startRelay(request);
      try {
        await provide(relay);
      } finally {
        await relay.stop();
      }
    },
    { auto: true },
  ],
  openProfile: async ({ browser }, provide) => {
    const profiles: { readonly person: Person; readonly violations: string[] }[] = [];
    await provide(async (name, options = {}) => {
      // The project's `use` options (baseURL, device) apply; the CSP always does.
      const context = await browser.newContext({ ...options, bypassCSP: false });
      const violations: string[] = [];
      await context.exposeFunction(REPORT_VIOLATION, (line: string) => {
        violations.push(line);
      });
      await context.addInitScript(recordCspViolations, REPORT_VIOLATION);
      const person = { name, page: await context.newPage() };
      profiles.push({ person, violations });
      return person;
    });
    try {
      // A round trip through each page lets any queued violation report arrive.
      for (const { person } of profiles) await person.page.evaluate(() => undefined);
      const all = profiles.flatMap(({ person, violations }) =>
        violations.map((line) => `${person.name}: ${line}`),
      );
      expect(all, 'CSP violations').toEqual([]);
    } finally {
      await Promise.all(profiles.map(({ person }) => person.page.context().close()));
    }
  },
});

export { expect };

/** The screen's one `h1`. */
export function heading(page: Page, name: string): Locator {
  return page.getByRole('heading', { level: 1, name });
}
