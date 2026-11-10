/**
 * What the end-to-end specs share: a fresh run of the real relay for each
 * test (`relay.ts`), a fixture that opens one browser profile per person
 * under the deploy CSP and fails the test on any CSP violation in any of
 * them, axe on the screen a person is looking at, a few locators, and
 * first run's steps (#76).
 */
import AxeBuilder from '@axe-core/playwright';
import {
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  test as base,
} from '@playwright/test';

import { type RunningRelay, startRelay } from './relay';

export { expect };

/** WCAG 2.0–2.2 A and AA plus axe's best practices, as `src/test/axe.ts`, with contrast on. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

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

/**
 * Playwright's `test`, with the relay started before each test and stopped after
 * it, and `openProfile`: each profile it opens is checked for CSP violations.
 */
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

/** The screen's one `h1`. */
export function heading(page: Page, name: string): Locator {
  return page.getByRole('heading', { level: 1, name });
}

/** Fails on any axe violation on the screen `person` is looking at. */
export async function expectAccessible(person: Person, screen: string): Promise<void> {
  const results = await new AxeBuilder({ page: person.page }).withTags(AXE_TAGS).analyze();
  const lines = results.violations.map((violation) => {
    const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ');
    return `${violation.id}: ${violation.help} (${targets})`;
  });
  expect(lines, `axe on ${person.name}'s ${screen}`).toEqual([]);
}

/**
 * Presses the React Aria radio `name`, inside `within` when given: React Aria
 * hides the native input under its label, so this presses the label.
 */
export async function pick(page: Page, name: string, within?: Locator): Promise<void> {
  const scope = within ?? page;
  const radio = scope.getByRole('radio', { name });
  // `has` is matched inside each label, so it names the radio from the page, not the scope.
  await scope.locator('label', { has: page.getByRole('radio', { name }) }).click();
  await expect(radio).toBeChecked();
}

/**
 * The `localStorage` key of the first-run guide's flag (`src/platform/guide.ts`,
 * #91). The specs reach the app only from outside, so they spell it here.
 */
export const GUIDE_KEY = 'reconcile.first-run-guide';

/** What first run leaves for later in a profile. */
export interface FirstRunOptions {
  /** True to meet the first-run guide (#91) after the profile's first create or join. */
  readonly guide?: boolean;
}

/**
 * First run (#76): a new profile's pilot notice, checked by axe, then
 * accepted. Unless `guide` is true, the profile then counts the first-run
 * guide (#91) as seen, as its Skip leaves it, so a spec about something else
 * isn't stopped by the guide's dialog after its first create or join.
 */
export async function acceptNotice(person: Person, options: FirstRunOptions = {}): Promise<void> {
  await expect(heading(person.page, 'Before you start')).toBeVisible();
  await expectAccessible(person, 'Pilot notice');
  await person.page.getByRole('button', { name: 'I understand' }).click();
  if (options.guide === true) return;
  await person.page.evaluate((key) => {
    window.localStorage.setItem(key, '1');
  }, GUIDE_KEY);
}

/** The keys in the origin's `localStorage` on `page`, sorted. */
export function localKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(window.localStorage).sort());
}

/** A group to found: its name, its Document's title and sections, and the founder's name. */
export interface NewGroup {
  readonly name: string;
  readonly title: string;
  readonly atoms: readonly string[];
  readonly founder: string;
}

/**
 * From Start, founds `group`, waits for Group home (its genesis is back from
 * the relay), presses Copy invite link, and returns the link it made (#73).
 */
export async function foundGroup(page: Page, group: NewGroup): Promise<string> {
  await page.getByRole('link', { name: 'Create group' }).click();
  await page.getByRole('textbox', { name: 'Group name' }).fill(group.name);
  await page.getByRole('textbox', { name: 'Your name' }).fill(group.founder);
  await page.getByRole('textbox', { name: 'Document title' }).fill(group.title);
  await page.getByRole('textbox', { name: 'Document text' }).fill(group.atoms.join('\n\n'));
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(heading(page, group.name)).toBeVisible();
  await page.getByRole('button', { name: 'Copy invite link' }).click();
  const link = page.getByRole('textbox', { name: 'Invite link' });
  await expect(link).toHaveValue(/#join\/[\w-]{43}$/);
  return link.inputValue();
}

/** The number of records in every IndexedDB database the page's origin holds. */
export async function storedRecords(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const settle = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(new Error('IndexedDB refused the read.'));
        };
      });
    let records = 0;
    for (const { name } of await indexedDB.databases()) {
      if (name === undefined) continue;
      const db = await settle(indexedDB.open(name));
      for (const store of db.objectStoreNames) {
        records += await settle(db.transaction(store).objectStore(store).count());
      }
      db.close();
    }
    return records;
  });
}
