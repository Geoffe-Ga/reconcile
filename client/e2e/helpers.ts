/**
 * What the first-run, offline and CSP specs (#76) share: the screen's heading,
 * the pilot notice every new profile accepts, axe, and a CSP watch.
 */
import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, expect, type Locator, type Page } from '@playwright/test';

/** WCAG 2.0–2.2 A and AA plus axe's best practices, as `src/test/axe.ts`, with contrast on. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** The name the init script reports CSP violations to, exposed on every page. */
const REPORT_VIOLATION = 'e2eReportCspViolation';

/** The screen's one `h1`. */
export function heading(page: Page, name: string): Locator {
  return page.getByRole('heading', { level: 1, name });
}

/** First run's pilot notice, which a new profile accepts before anything makes keys. */
export async function acceptNotice(page: Page): Promise<void> {
  await expect(heading(page, 'Before you start')).toBeVisible();
  await page.getByRole('button', { name: 'I understand' }).click();
}

/** Fails on any axe violation on the screen `page` shows. */
export async function expectAccessible(page: Page, screen: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const lines = results.violations.map((violation) => {
    const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ');
    return `${violation.id}: ${violation.help} (${targets})`;
  });
  expect(lines, `axe on ${screen}`).toEqual([]);
}

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

/** Every CSP violation any page in `context` reports from now on, as it arrives. */
export async function watchCspViolations(context: BrowserContext): Promise<string[]> {
  const violations: string[] = [];
  await context.exposeFunction(REPORT_VIOLATION, (line: string) => {
    violations.push(line);
  });
  await context.addInitScript(recordCspViolations, REPORT_VIOLATION);
  return violations;
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

/** The group the first-run and offline specs found. */
export const GROUP = 'Riverside Tenants';
export const TITLE = 'House rules';
export const ATOMS = ['Quiet hours start at 10pm.', 'Shared spaces are cleaned every Sunday.'];

/**
 * From Start, founds the group as `founder`, waits for Group home (its
 * genesis is back from the relay), and returns its invite link.
 */
export async function foundGroup(page: Page, founder: string): Promise<string> {
  await page.getByRole('link', { name: 'Create group' }).click();
  await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
  await page.getByRole('textbox', { name: 'Your name' }).fill(founder);
  await page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
  await page.getByRole('textbox', { name: 'Document text' }).fill(ATOMS.join('\n\n'));
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(heading(page, GROUP)).toBeVisible();
  return page.getByRole('textbox', { name: 'Invite link' }).inputValue();
}
